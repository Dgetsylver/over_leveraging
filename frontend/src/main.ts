/**
 * Blend Leverage UI — multi-pool support (Etherfuse, Fixed, YieldBlox)
 */

import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { FreighterModule }   from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule }       from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule }      from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule }      from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule }        from "@creit-tech/stellar-wallets-kit/modules/hana";
import { Networks }          from "@creit-tech/stellar-wallets-kit/types";
import { estimateSwap }      from "@stellar-broker/client";

import {
  KNOWN_POOLS,
  getPoolAssets,
  NETWORK,
  fetchAllReserves,
  fetchUserPositions,
  fetchAssetBalance,
  fetchPoolPendingBlnd,
  buildApproveXdr,
  buildOpenPositionXdr,
  buildCloseSubmitXdr,
  buildRepayXdr,
  buildClaimXdr,
  submitSignedXdr,
  hfForLeverage,
  maxLeverageFor,
  type AssetInfo,
  type PoolDef,
  type ReserveStats,
  type AssetPosition,
  type UserPositions,
} from "./blend.ts";

// ── Wallet kit ────────────────────────────────────────────────────────────────

StellarWalletsKit.init({
  modules: [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new LobstrModule(),
    new HanaModule(),
  ],
  network: Networks.PUBLIC,
});

// ── State ─────────────────────────────────────────────────────────────────────

let userAddress: string | null = null;
let reserves:    ReserveStats[]  = [];
let positions:   UserPositions   = { byAsset: new Map() };
let selectedPool: PoolDef        = KNOWN_POOLS[0]; // default: Etherfuse
let assets: AssetInfo[]          = getPoolAssets(selectedPool);
let selectedAsset: AssetInfo     = assets[2]; // default: CETES (index 2 in Etherfuse)

// ── Theme ────────────────────────────────────────────────────────────────────

type Theme = "light" | "dark";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.innerHTML = theme === "dark" ? "&#9790;" : "&#9728;";
}

// Initialize: check localStorage override, else follow system
const savedTheme = localStorage.getItem("theme") as Theme | null;
applyTheme(savedTheme ?? getSystemTheme());

// Listen for system changes (only when no manual override)
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!localStorage.getItem("theme")) applyTheme(getSystemTheme());
});

// ── Disclaimer ───────────────────────────────────────────────────────────

if (!localStorage.getItem("disclaimerAccepted")) {
  document.getElementById("disclaimer-overlay")!.classList.remove("hidden");
}
document.getElementById("disclaimer-checkbox")!.addEventListener("change", (e) => {
  (document.getElementById("disclaimer-accept") as HTMLButtonElement).disabled =
    !(e.target as HTMLInputElement).checked;
});
document.getElementById("disclaimer-accept")!.addEventListener("click", () => {
  localStorage.setItem("disclaimerAccepted", "1");
  document.getElementById("disclaimer-overlay")!.classList.add("hidden");
});

// ── Active view (leverage | swap) ────────────────────────────────────────

type AppView = "leverage" | "swap";
let activeView: AppView = "leverage";

// ── Expert mode ──────────────────────────────────────────────────────────────

let expertMode = false;
const MIN_HF_NORMAL = 1.01;
const MIN_HF_EXPERT = 1.005;
function minHF() { return expertMode ? MIN_HF_EXPERT : MIN_HF_NORMAL; }

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const fmt  = (n: number, d = 2) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtAddr = (addr: string) => addr.slice(0, 6) + "…" + addr.slice(-4);

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string, type: "info" | "success" | "error", hash?: string) {
  const el   = $("toast");
  const msgEl = $("toast-msg");
  const link  = $("toast-link") as HTMLAnchorElement;
  el.className = `toast toast-${type}`;
  $("toast-icon").textContent = type === "success" ? "✓" : type === "error" ? "✗" : "⟳";
  msgEl.textContent = msg;
  if (hash) { link.href = `https://stellar.expert/explorer/public/tx/${hash}`; link.classList.remove("hidden"); }
  else link.classList.add("hidden");
  el.classList.remove("hidden");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add("hidden"), type === "error" ? 9000 : 5000);
}

// ── Sign + submit ─────────────────────────────────────────────────────────────

async function signAndSubmit(xdrStr: string, label: string): Promise<string> {
  toast(`Sign "${label}" in your wallet…`, "info");
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdrStr, {
    networkPassphrase: NETWORK,
    address: userAddress!,
  });
  toast(`Submitting "${label}"…`, "info");
  const hash = await submitSignedXdr(signedTxXdr);
  toast(`"${label}" confirmed!`, "success", hash);
  return hash;
}

// ── Pool tabs ─────────────────────────────────────────────────────────────────

function buildPoolTabs() {
  const container = $("pool-tabs");
  container.innerHTML = "";
  KNOWN_POOLS.forEach(pool => {
    const btn = document.createElement("button");
    const isFrozen = pool.status !== 1;
    btn.className = `pool-tab ${pool.id === selectedPool.id ? "active" : ""} ${isFrozen ? "pool-tab-frozen" : ""}`;
    btn.dataset["poolId"] = pool.id;
    btn.textContent = pool.name;
    if (isFrozen) btn.title = "Admin Frozen — exploited Feb 2026";
    btn.addEventListener("click", () => selectPool(pool));
    container.appendChild(btn);
  });
}

function selectPool(pool: PoolDef) {
  selectedPool = pool;

  document.querySelectorAll<HTMLButtonElement>(".pool-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["poolId"] === pool.id);
  });

  const banner = $("pool-frozen-banner");
  if (pool.status !== 1) {
    banner.classList.remove("hidden");
    ($("open-btn") as HTMLButtonElement).disabled = true;
  } else {
    banner.classList.add("hidden");
  }

  assets = getPoolAssets(pool);
  selectedAsset = assets[0];

  buildAssetTabs();
  ($("asset-symbol-suffix") as HTMLElement).textContent = selectedAsset.symbol;
  updateLeverageSlider(selectedAsset.cFactor);

  if (userAddress) loadAll();
}

// ── Asset tabs ────────────────────────────────────────────────────────────────

/** Set leverage slider min/max/step based on asset cFactor and lFactor. */
function updateLeverageSlider(c: number, l: number = 1) {
  const slider = $("leverage-slider") as HTMLInputElement;
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const maxLev = Math.floor(maxLeverageFor(c, l, minHF()) * 10) / 10; // floor to 1 decimal
  slider.min = numIn.min = "1.1";
  slider.max = numIn.max = String(maxLev);
  slider.step = numIn.step = "0.1";
  const cur = parseFloat(slider.value);
  const clamped = Math.min(maxLev, Math.max(1.1, cur));
  if (clamped !== cur) { slider.value = String(clamped); numIn.value = String(clamped); }
}

function buildAssetTabs() {
  const container = $("asset-tabs");
  container.innerHTML = "";
  assets.forEach(asset => {
    const btn = document.createElement("button");
    btn.className = `asset-tab ${asset.id === selectedAsset.id ? "active" : ""}`;
    btn.dataset["assetId"] = asset.id;
    btn.innerHTML = `<span class="tab-symbol">${asset.symbol}</span>`;
    btn.addEventListener("click", () => selectAsset(asset));
    container.appendChild(btn);
  });
}

function selectAsset(asset: AssetInfo) {
  selectedAsset = asset;
  document.querySelectorAll<HTMLButtonElement>(".asset-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["assetId"] === asset.id);
  });
  ($("asset-symbol-suffix") as HTMLElement).textContent = asset.symbol;

  const rs = reserves.find(r => r.asset.id === asset.id);
  updateLeverageSlider(rs ? rs.cFactor : asset.cFactor, rs?.lFactor ?? 1);

  renderSelectedAsset();
  if (userAddress) refreshTabData();
}

/** Fetch only balance for the current asset (BLND is pool-wide, fetched in loadAll). */
async function refreshTabData() {
  if (!userAddress) return;
  try {
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    $("asset-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;
  } catch { /* silently ignore */ }
}

// ── Render reserve stats for selected asset ───────────────────────────────────

function renderSelectedAsset() {
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  if (!rs) return;

  updateLeverageSlider(rs.cFactor, rs.lFactor);

  const maxLev = maxLeverageFor(rs.cFactor, rs.lFactor, minHF());
  $("stat-cfactor").textContent    = `${(rs.cFactor * 100).toFixed(0)}%`;
  $("stat-max-lev").textContent    = `${maxLev.toFixed(2)}×`;
  $("stat-liquidity").textContent  = `${fmt(rs.available, 0)} ${rs.asset.symbol}`;

  // Utilization display with color coding
  const util = rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;
  const utilEl = $("stat-util");
  utilEl.textContent = `${(util * 100).toFixed(1)}%`;
  utilEl.className = `stat-value ${util > 0.90 ? "hf-bad" : util > 0.75 ? "hf-warn" : ""}`;

  $("stat-price").textContent      = rs.priceUsd > 0 ? `$${fmt(rs.priceUsd, 4)}` : "—";

  renderAprLine("supply-interest-apr", rs.interestSupplyApr, false);
  renderAprLine("supply-blnd-apr",     rs.blndSupplyApr,     false, true);
  renderAprLine("supply-net-apr",      rs.netSupplyApr,      false);
  renderAprLine("borrow-interest-apr", rs.interestBorrowApr, true);
  renderAprLine("borrow-blnd-apr",     rs.blndBorrowApr,     false, true);
  renderAprLine("borrow-net-cost",     rs.netBorrowCost,     true);

  updatePreview();
  renderPosition();
}

function renderAprLine(id: string, val: number, isCost: boolean, isBlnd = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = `${val >= 0 ? "+" : ""}${fmt(val, 2)}%`;
  el.className = "apr-val " + (
    isBlnd ? "apr-blnd" :
    isCost ? (val > 5 ? "apr-bad" : val > 2 ? "apr-warn" : "apr-ok") :
             (val > 5 ? "apr-great" : val > 2 ? "apr-ok" : "apr-dim")
  );
}

// ── Pool-wide health factor ───────────────────────────────────────────────────

function computePoolHF(): number {
  let weightedCollateral = 0;
  let totalDebt          = 0;
  for (const pos of positions.byAsset.values()) {
    const rs = reserves.find(r => r.asset.id === pos.asset.id);
    if (!rs) continue;
    weightedCollateral += pos.collateral * rs.cFactor * rs.priceUsd;
    totalDebt          += (pos.debt / rs.lFactor) * rs.priceUsd;
  }
  return totalDebt > 0 ? weightedCollateral / totalDebt : Infinity;
}

// ── Position display ──────────────────────────────────────────────────────────

function renderPosition() {
  const pos = positions.byAsset.get(selectedAsset.id);

  if (!pos) {
    $("no-position").classList.remove("hidden");
    $("position-data").classList.add("hidden");
    ($("close-btn") as HTMLButtonElement).disabled = true;
    ($("repay-btn") as HTMLButtonElement).disabled = true;
    return;
  }

  $("no-position").classList.add("hidden");
  $("position-data").classList.remove("hidden");
  ($("close-btn") as HTMLButtonElement).disabled = false;
  ($("repay-btn") as HTMLButtonElement).disabled = pos.dTokens === 0n;

  $("pos-collateral").textContent = `${fmt(pos.collateral, 4)} ${pos.asset.symbol}`;
  $("pos-debt").textContent       = `${fmt(pos.debt, 4)} ${pos.asset.symbol}`;
  $("pos-equity").textContent     = `${fmt(pos.equity, 4)} ${pos.asset.symbol}`;
  $("pos-leverage").textContent   = `${fmt(pos.leverage, 2)}×`;

  // Per-asset health factor
  const hf = pos.hf;
  const hfEl = $("pos-hf");
  hfEl.textContent = isFinite(hf) ? fmt(hf, 3) : "∞";
  hfEl.className   = `metric-value ${hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad"}`;
  const barPct = Math.min(100, Math.max(0, (hf - 1) / 0.3 * 100));
  const bar = $("hf-bar");
  bar.style.width      = `${barPct}%`;
  bar.style.background = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";

  // Pool-wide health factor
  const poolHF   = computePoolHF();
  const poolHFEl = $("pos-pool-hf");
  poolHFEl.textContent = isFinite(poolHF) ? fmt(poolHF, 3) : "∞";
  poolHFEl.className   = `metric-value ${poolHF > 1.1 ? "hf-ok" : poolHF > 1.03 ? "hf-warn" : "hf-bad"}`;

  // Borrow headroom: (collateral × cFactor − debt / lFactor) × priceUsd
  // = how much more USD-worth can be borrowed before hitting HF = 1
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const headroomEl = $("pos-headroom");
  if (rs && rs.priceUsd > 0) {
    const effectiveCollateral = pos.collateral * rs.cFactor;
    const effectiveDebt       = pos.debt / rs.lFactor;
    const headroom  = Math.max(0, effectiveCollateral - effectiveDebt) * rs.priceUsd;
    headroomEl.textContent = `$${fmt(headroom, 2)}`;
    headroomEl.className   = `metric-value mono ${headroom < 5 ? "hf-bad" : headroom < 20 ? "hf-warn" : ""}`;
  } else {
    headroomEl.textContent = "—";
    headroomEl.className   = "metric-value mono";
  }

  // Net APY at current leverage — this is % of initial equity (your deposit)
  const netAprEl = $("pos-net-apr");
  if (rs && pos.leverage > 0) {
    const netApr = rs.netSupplyApr * pos.leverage - rs.netBorrowCost * (pos.leverage - 1);
    netAprEl.textContent = `${netApr >= 0 ? "+" : ""}${fmt(netApr, 2)}%`;
    netAprEl.className   = `metric-value ${netApr > 0 ? "hf-ok" : "hf-bad"}`;
  } else {
    netAprEl.textContent = "—";
    netAprEl.className   = "metric-value";
  }

  // Days until liquidation — interest-only drift (no BLND emissions).
  //
  // With compound interest both collateral and debt grow exponentially:
  //   HF(t) = HF₀ × e^((supplyAPR − borrowAPR) × t)
  // Solving for HF(t) = 1:
  //   t_years = ln(HF₀) / (borrowAPR − supplyAPR)
  //
  // Leverage is already embedded in HF₀ (higher lev → lower HF₀ → fewer days).
  // The erosion rate is purely the raw APR spread, independent of leverage.
  const liqDaysEl  = $("pos-liq-days");
  const liqNoteEl  = $("pos-liq-note");
  if (rs && pos.leverage > 0 && isFinite(pos.hf) && pos.hf > 1) {
    const spreadPct = rs.interestBorrowApr - rs.interestSupplyApr; // positive = HF eroding
    if (spreadPct <= 0) {
      liqDaysEl.textContent = "Never (supply APR ≥ borrow APR)";
      liqDaysEl.className   = "metric-value hf-ok";
      liqNoteEl.textContent = "";
    } else {
      const daysLeft = Math.log(pos.hf) / (spreadPct / 100) * 365;
      liqDaysEl.textContent = daysLeft > 3650 ? ">10 years" : `~${Math.round(daysLeft)} days`;
      liqDaysEl.className   = `metric-value ${daysLeft < 30 ? "hf-bad" : daysLeft < 90 ? "hf-warn" : "hf-ok"}`;
      liqNoteEl.textContent = `Interest spread: ${fmt(spreadPct, 2)}%/yr (borrow − supply). Claim & convert BLND to extend runway.`;
    }
  } else {
    liqDaysEl.textContent = "—";
    liqDaysEl.className   = "metric-value";
    liqNoteEl.textContent = "";
  }
}

// ── Leverage preview ──────────────────────────────────────────────────────────

function updatePreview() {
  const slider = $("leverage-slider") as HTMLInputElement;
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const lev    = parseFloat(slider.value) || 1.1;
  // Keep the number input in sync with the slider
  if (parseFloat(numIn.value) !== lev) numIn.value = lev.toFixed(1);
  const initial = parseFloat(($("initial-input") as HTMLInputElement).value) || 0;
  const rs      = reserves.find(r => r.asset.id === selectedAsset.id);
  const c       = rs ? rs.cFactor : selectedAsset.cFactor;
  const l       = rs?.lFactor ?? 1;
  const hf      = hfForLeverage(lev, c, l);

  $("prev-lev").textContent = `${lev.toFixed(2)}×`;
  $("prev-supply").textContent      = `${fmt(initial * lev, 2)} ${selectedAsset.symbol}`;
  $("prev-borrow").textContent      = `${fmt(initial * (lev - 1), 2)} ${selectedAsset.symbol}`;
  $("prev-hf").textContent          = isFinite(hf) ? fmt(hf, 3) : "∞";
  $("prev-hf").className            = hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad";

  if (rs) {
    const netApr = rs.netSupplyApr * lev - rs.netBorrowCost * (lev - 1);
    $("prev-net-apr").textContent = `${fmt(netApr, 2)}% APY on equity`;
    $("prev-net-apr").className   = `prev-net-apr ${netApr > 0 ? "apr-great" : "apr-bad"}`;

    // Days until liquidation at this leverage (interest-only, no BLND)
    const spreadPct = rs.interestBorrowApr - rs.interestSupplyApr;
    const prevLiqEl = $("prev-liq-days");
    if (spreadPct <= 0) {
      prevLiqEl.textContent = "Never";
      prevLiqEl.className   = "hf-ok";
    } else if (isFinite(hf) && hf > 1) {
      const days = Math.log(hf) / (spreadPct / 100) * 365;
      prevLiqEl.textContent = days > 3650 ? ">10 years" : `~${Math.round(days)} days`;
      prevLiqEl.className   = days < 30 ? "hf-bad" : days < 90 ? "hf-warn" : "hf-ok";
    } else {
      prevLiqEl.textContent = "—";
      prevLiqEl.className   = "";
    }
  }

  // Liquidity check: first borrow step must fit within pool available + what your deposit unlocks.
  // Subsequent steps are fine because each deposit replenishes capacity.
  const totalBorrow = initial * (lev - 1);
  const cf = rs ? rs.cFactor : selectedAsset.cFactor;
  const firstBorrow = Math.min(initial * cf, totalBorrow);
  const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
  const liquidityOk = !rs || firstBorrow <= poolAvailAfterDeposit;
  const liquidityWarnEl = $("liquidity-warning") as HTMLElement;
  if (!liquidityOk && rs) {
    liquidityWarnEl.textContent = `⚠ First borrow (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol}). Reduce leverage or deposit.`;
    liquidityWarnEl.classList.remove("hidden");
  } else {
    liquidityWarnEl.classList.add("hidden");
  }

  const safe = hf >= minHF() && selectedPool.status === 1 && liquidityOk;
  ($("hf-warning") as HTMLElement).classList.toggle("hidden", hf >= minHF() || selectedPool.status !== 1);
  ($("open-btn") as HTMLButtonElement).disabled = !safe;
}

// ── Load data ─────────────────────────────────────────────────────────────────

let _loadInProgress = false;

async function loadAll() {
  if (!userAddress || _loadInProgress) return;
  _loadInProgress = true;
  try {
    reserves  = await fetchAllReserves(selectedPool, userAddress);
    positions = await fetchUserPositions(selectedPool, userAddress, reserves);

    // Balance for selected asset
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    $("asset-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;

    // Pool-wide pending BLND (simulate claim for all positions in this pool)
    const blnd = await fetchPoolPendingBlnd(selectedPool, userAddress, positions);
    $("pos-blnd").textContent = `${fmt(blnd, 4)} BLND`;
    ($("claim-btn") as HTMLButtonElement).disabled = blnd <= 0;

    renderSelectedAsset();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to load pool data:", e);
    toast(`Load failed: ${msg.slice(0, 120)}`, "error");
  } finally {
    _loadInProgress = false;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function openPosition() {
  if (!userAddress) return;
  if (selectedPool.status !== 1) { toast("Pool is frozen — cannot open new positions", "error"); return; }
  const initial  = parseFloat(($("initial-input") as HTMLInputElement).value);
  const leverage = parseFloat(($("leverage-slider") as HTMLInputElement).value);
  if (isNaN(initial) || initial <= 0) { toast("Enter a valid amount", "error"); return; }

  // Use live cFactor from reserves so intermediate borrow steps don't exceed pool limits
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const liveAsset = rs?.asset ?? selectedAsset;

  if (hfForLeverage(leverage, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) { toast("HF too low — reduce leverage", "error"); return; }

  const totalBorrow   = initial * (leverage - 1);
  const firstBorrow   = Math.min(initial * liveAsset.cFactor, totalBorrow);
  const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
  if (rs && firstBorrow > poolAvailAfterDeposit) {
    toast(`First borrow step (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol}). Reduce leverage.`, "error");
    return;
  }

  const initialStroops = BigInt(Math.round(initial * 1e7));
  setLoading($("open-btn") as HTMLButtonElement, true);
  try {
    const approveXdr = await buildApproveXdr(selectedPool, userAddress, liveAsset.id, initialStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${liveAsset.symbol}`);
    const submitXdr = await buildOpenPositionXdr(selectedPool, userAddress, liveAsset, initialStroops, leverage);
    await signAndSubmit(submitXdr, `Open ${liveAsset.symbol} leverage`);
    await loadAll();
  } catch (e: any) {
    // Translate known Blend contract error codes to human-readable messages
    const msg: string = e?.message ?? "Transaction failed";
    if (msg.includes("#1205") || msg.includes("InvalidHf")) {
      toast("Health factor too low — reduce leverage.", "error");
    } else if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) {
      toast("Pool utilization limit reached — not enough liquidity for this borrow. Reduce leverage or deposit.", "error");
    } else {
      toast(msg.slice(0, 200), "error");
    }
  } finally {
    setLoading($("open-btn") as HTMLButtonElement, false);
  }
}

async function closePosition() {
  if (!userAddress) return;
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;
  setLoading($("close-btn") as HTMLButtonElement, true);
  try {
    // submit uses Soroban auth propagation — no approve transaction needed
    const submitXdr = await buildCloseSubmitXdr(selectedPool, userAddress, pos);
    await signAndSubmit(submitXdr, `Close ${selectedAsset.symbol} position`);
    await loadAll();
  } catch (e: any) {
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("close-btn") as HTMLButtonElement, false);
  }
}

async function repayDebt() {
  if (!userAddress) return;
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos || pos.dTokens === 0n) return;
  setLoading($("repay-btn") as HTMLButtonElement, true);
  try {
    const repayXdr = await buildRepayXdr(selectedPool, userAddress, pos);
    await signAndSubmit(repayXdr, `Repay ${selectedAsset.symbol} debt`);
    await loadAll();
  } catch (e: any) {
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("repay-btn") as HTMLButtonElement, false);
  }
}

async function maxDeposit() {
  if (!userAddress) return;
  try {
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    ($("initial-input") as HTMLInputElement).value = String(Math.floor(bal * 1e7) / 1e7);
    updatePreview();
  } catch { /* ignore */ }
}

async function claimBlnd() {
  if (!userAddress) return;
  // Collect all token IDs for ALL positions in this pool
  const tokenIds: number[] = [];
  for (const pos of positions.byAsset.values()) {
    if (pos.bTokens > 0n) tokenIds.push(pos.asset.supplyTokenId);
    if (pos.dTokens > 0n) tokenIds.push(pos.asset.borrowTokenId);
  }
  if (tokenIds.length === 0) { toast("No positions to claim from", "error"); return; }

  setLoading($("claim-btn") as HTMLButtonElement, true);
  try {
    const claimXdr = await buildClaimXdr(selectedPool, userAddress, tokenIds);
    await signAndSubmit(claimXdr, "Claim BLND");
    await loadAll();
  } catch (e: any) {
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("claim-btn") as HTMLButtonElement, false);
  }
}

function setLoading(btn: HTMLButtonElement, on: boolean) {
  btn.disabled = on;
  btn.classList.toggle("btn-loading", on);
}

// ── Wallet connect / switch / disconnect ──────────────────────────────────────

function showConnected() {
  $("wallet-address").textContent = fmtAddr(userAddress!);
  $("connect-btn").classList.add("hidden");
  $("wallet-connected").classList.remove("hidden");
  $("connect-prompt").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
}

async function connect() {
  try {
    const result = await StellarWalletsKit.authModal({ network: Networks.PUBLIC });
    userAddress  = result.address;
    localStorage.setItem("walletAddress", userAddress);
    showConnected();
    buildPoolTabs();
    buildAssetTabs();
    await loadAll();
  } catch (e: any) {
    if (e?.message !== "User closed the modal") toast("Failed to connect wallet", "error");
  }
}

/** Re-open wallet modal to switch to a different account without a full page reload. */
async function switchWallet() {
  try {
    const result = await StellarWalletsKit.authModal({ network: Networks.PUBLIC });
    if (result.address === userAddress) return;
    userAddress = result.address;
    localStorage.setItem("walletAddress", userAddress);
    $("wallet-address").textContent = fmtAddr(userAddress);
    reserves  = [];
    positions = { byAsset: new Map() };
    await loadAll();
    toast("Switched wallet", "success");
  } catch (e: any) {
    if (e?.message !== "User closed the modal") toast("Failed to switch wallet", "error");
  }
}

async function disconnect() {
  await StellarWalletsKit.disconnect();
  userAddress = null;
  localStorage.removeItem("walletAddress");
  reserves    = [];
  positions   = { byAsset: new Map() };
  $("connect-btn").classList.remove("hidden");
  $("wallet-connected").classList.add("hidden");
  $("connect-prompt").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
}

// ── View switching (Leverage / Swap) ─────────────────────────────────────

function switchView(view: AppView) {
  activeView = view;
  const blendBtn = $("proto-blend");
  const swapBtn  = $("proto-swap");
  blendBtn.classList.toggle("active", view === "leverage");
  swapBtn.classList.toggle("active", view === "swap");

  // Toggle pool tabs visibility
  $("pool-tabs").style.display = view === "leverage" ? "" : "none";

  if (view === "leverage") {
    $("swap-view").classList.add("hidden");
    if (userAddress) {
      $("dashboard").classList.remove("hidden");
      $("connect-prompt").classList.add("hidden");
    } else {
      $("dashboard").classList.add("hidden");
      $("connect-prompt").classList.remove("hidden");
    }
    // Show asset tabs & header elements for leverage
    $("asset-tabs").style.display = "";
  } else {
    $("dashboard").classList.add("hidden");
    $("connect-prompt").classList.add("hidden");
    $("swap-view").classList.remove("hidden");
    // Hide asset tabs in swap mode
    $("asset-tabs").style.display = "none";
    populateSwapAssets();
    updateSwapBtn();
  }
}

// ── Swap assets ──────────────────────────────────────────────────────────

const SWAP_ASSETS: { symbol: string; id: string }[] = [
  { symbol: "XLM",  id: "native" },
  { symbol: "USDC", id: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { symbol: "BLND", id: "BLND-CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY" },
  { symbol: "AQUA", id: "AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
];

// Add pool assets dynamically
function getSwapAssetList(): { symbol: string; id: string }[] {
  const seen = new Set(SWAP_ASSETS.map(a => a.id));
  const list = [...SWAP_ASSETS];
  for (const pool of KNOWN_POOLS) {
    for (const asset of getPoolAssets(pool)) {
      if (!seen.has(asset.id)) {
        seen.add(asset.id);
        list.push({ symbol: asset.symbol, id: asset.id });
      }
    }
  }
  return list;
}

function populateSwapAssets() {
  const sellSelect = $("swap-sell-asset") as HTMLSelectElement;
  const buySelect  = $("swap-buy-asset") as HTMLSelectElement;
  if (sellSelect.options.length > 0) return; // already populated

  const list = getSwapAssetList();
  list.forEach(a => {
    sellSelect.add(new Option(a.symbol, a.id));
    buySelect.add(new Option(a.symbol, a.id));
  });
  // Defaults: sell XLM, buy USDC
  sellSelect.value = "native";
  if (list.find(a => a.id.startsWith("USDC"))) {
    buySelect.value = list.find(a => a.id.startsWith("USDC"))!.id;
  } else {
    buySelect.selectedIndex = 1;
  }
}

/** Convert our asset id format to Stellar Broker format */
function toBrokerAsset(id: string): string {
  if (id === "native") return "XLM";
  // Our format: CODE-ISSUER  → Broker format: CODE-ISSUER (same)
  return id;
}

let _quoteTimer: ReturnType<typeof setTimeout> | null = null;
let _lastQuote: any = null;

async function fetchSwapQuote() {
  const sellAmount = ($("swap-sell-amount") as HTMLInputElement).value;
  const sellAsset  = ($("swap-sell-asset") as HTMLSelectElement).value;
  const buyAsset   = ($("swap-buy-asset") as HTMLSelectElement).value;

  if (!sellAmount || parseFloat(sellAmount) <= 0 || sellAsset === buyAsset) {
    $("swap-quote-details").classList.add("hidden");
    ($("swap-buy-amount") as HTMLInputElement).value = "";
    _lastQuote = null;
    updateSwapBtn();
    return;
  }

  try {
    const quote = await estimateSwap({
      sellingAsset: toBrokerAsset(sellAsset),
      buyingAsset: toBrokerAsset(buyAsset),
      sellingAmount: sellAmount,
      slippageTolerance: 0.02,
    });

    _lastQuote = quote;

    if (quote.status === "success" && quote.estimatedBuyingAmount) {
      ($("swap-buy-amount") as HTMLInputElement).value = parseFloat(quote.estimatedBuyingAmount).toFixed(7);

      const sellNum = parseFloat(sellAmount);
      const buyNum  = parseFloat(quote.estimatedBuyingAmount);
      const sellSym = ($("swap-sell-asset") as HTMLSelectElement).selectedOptions[0].text;
      const buySym  = ($("swap-buy-asset") as HTMLSelectElement).selectedOptions[0].text;

      $("swap-rate").textContent = `1 ${sellSym} ≈ ${(buyNum / sellNum).toFixed(6)} ${buySym}`;
      $("swap-direct").textContent = quote.directTrade
        ? `${parseFloat(quote.directTrade.buying).toFixed(7)} ${buySym}`
        : "—";
      $("swap-profit").textContent = quote.profit ? `${quote.profit}` : "—";
      $("swap-quote-details").classList.remove("hidden");
    } else {
      ($("swap-buy-amount") as HTMLInputElement).value = quote.status === "unfeasible" ? "No route" : "—";
      $("swap-quote-details").classList.add("hidden");
      _lastQuote = null;
    }
  } catch (e: any) {
    ($("swap-buy-amount") as HTMLInputElement).value = "Error";
    $("swap-quote-details").classList.add("hidden");
    _lastQuote = null;
    console.error("Swap quote error:", e);
  }
  updateSwapBtn();
}

function updateSwapBtn() {
  const btn = $("swap-btn") as HTMLButtonElement;
  const sellAmount = ($("swap-sell-amount") as HTMLInputElement).value;
  const hasAmount = sellAmount && parseFloat(sellAmount) > 0;
  const sellAsset = ($("swap-sell-asset") as HTMLSelectElement).value;
  const buyAsset  = ($("swap-buy-asset") as HTMLSelectElement).value;
  const samePair = sellAsset === buyAsset;

  if (!userAddress) {
    btn.textContent = "Connect Wallet";
    btn.disabled = true;
  } else if (samePair) {
    btn.textContent = "Select different assets";
    btn.disabled = true;
  } else if (!hasAmount) {
    btn.textContent = "Enter amount";
    btn.disabled = true;
  } else if (_lastQuote && _lastQuote.status === "success") {
    btn.textContent = "Swap (coming soon)";
    btn.disabled = true; // Execution will be enabled in a future update
  } else {
    btn.textContent = "Get Quote";
    btn.disabled = true;
  }
}

function debounceQuote() {
  if (_quoteTimer) clearTimeout(_quoteTimer);
  _quoteTimer = setTimeout(fetchSwapQuote, 500);
}

// ── Event listeners ───────────────────────────────────────────────────────────

$("expert-toggle").addEventListener("click", () => {
  expertMode = !expertMode;
  const btn = $("expert-toggle");
  btn.classList.toggle("expert-active", expertMode);
  btn.textContent = expertMode ? "Expert ON" : "Expert";
  renderSelectedAsset();
  updatePreview();
});

$("theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") as Theme || getSystemTheme();
  const next: Theme = current === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
});

// Protocol nav
$("proto-blend").addEventListener("click", () => switchView("leverage"));
$("proto-swap").addEventListener("click",  () => switchView("swap"));

// Swap events
$("swap-sell-amount").addEventListener("input", debounceQuote);
$("swap-sell-asset").addEventListener("change", () => { _lastQuote = null; debounceQuote(); updateSwapBalance(); });
$("swap-buy-asset").addEventListener("change",  () => { _lastQuote = null; debounceQuote(); });
$("swap-reverse").addEventListener("click", () => {
  const sell = $("swap-sell-asset") as HTMLSelectElement;
  const buy  = $("swap-buy-asset") as HTMLSelectElement;
  const tmp = sell.value;
  sell.value = buy.value;
  buy.value = tmp;
  _lastQuote = null;
  debounceQuote();
  updateSwapBalance();
});

async function updateSwapBalance() {
  if (!userAddress) return;
  const sellAsset = ($("swap-sell-asset") as HTMLSelectElement).value;
  try {
    const bal = await fetchAssetBalance(userAddress, sellAsset);
    const sym = ($("swap-sell-asset") as HTMLSelectElement).selectedOptions[0].text;
    $("swap-sell-balance").textContent = `${fmt(bal, 4)} ${sym}`;
  } catch { $("swap-sell-balance").textContent = "—"; }
}

$("connect-btn").addEventListener("click",    connect);
$("switch-wallet-btn").addEventListener("click", switchWallet);
$("disconnect-btn").addEventListener("click", disconnect);
$("refresh-btn").addEventListener("click",    () => loadAll());
$("open-btn").addEventListener("click",       openPosition);
$("close-btn").addEventListener("click",      closePosition);
$("repay-btn").addEventListener("click",      repayDebt);
$("claim-btn").addEventListener("click",      claimBlnd);
$("max-btn").addEventListener("click",        maxDeposit);

($("leverage-slider") as HTMLInputElement).addEventListener("input",  updatePreview);
// Live preview while typing (no clamping so user can type multi-digit numbers like "10")
($("leverage-input")  as HTMLInputElement).addEventListener("input", () => {
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const slider = $("leverage-slider") as HTMLInputElement;
  const v = parseFloat(numIn.value);
  if (!isNaN(v) && v >= 1.1) {
    slider.value = v.toFixed(1);
    updatePreview();
  }
});
// Clamp on blur / Enter so the final value is within valid range
($("leverage-input")  as HTMLInputElement).addEventListener("change", () => {
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const slider = $("leverage-slider") as HTMLInputElement;
  let v = parseFloat(numIn.value);
  if (isNaN(v)) v = 1.1;
  v = Math.min(parseFloat(slider.max), Math.max(1.1, Math.round(v * 10) / 10));
  numIn.value  = v.toFixed(1);
  slider.value = v.toFixed(1);
  updatePreview();
});
($("initial-input")   as HTMLInputElement).addEventListener("input",  () => { refreshTabData(); updatePreview(); });
($("initial-input")   as HTMLInputElement).addEventListener("change", () => { refreshTabData(); updatePreview(); });

// Init preview with defaults
updatePreview();

// ── Auto-reconnect saved wallet ──────────────────────────────────────────────
(async () => {
  const saved = localStorage.getItem("walletAddress");
  if (!saved) return;
  userAddress = saved;
  showConnected();
  buildPoolTabs();
  buildAssetTabs();
  await loadAll();
})();
