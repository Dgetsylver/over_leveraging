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

/** Set leverage slider min/max/step based on asset cFactor. */
function updateLeverageSlider(c: number) {
  const slider = $("leverage-slider") as HTMLInputElement;
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const maxLev = Math.floor(maxLeverageFor(c) * 10) / 10; // floor to 1 decimal
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
  updateLeverageSlider(rs ? rs.cFactor : asset.cFactor);

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

  updateLeverageSlider(rs.cFactor);

  const maxLev = 1.055 / (1.055 - rs.cFactor);
  $("stat-cfactor").textContent    = `${(rs.cFactor * 100).toFixed(0)}%`;
  $("stat-max-lev").textContent    = `${maxLev.toFixed(2)}×`;
  $("stat-liquidity").textContent  = `${fmt(rs.available, 0)} ${rs.asset.symbol}`;

  // Utilization display with color coding
  const util = rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;
  const utilEl = $("stat-util");
  utilEl.textContent = `${(util * 100).toFixed(1)}%`;
  utilEl.className = `stat-value ${util > MAX_SAFE_UTILIZATION ? "hf-bad" : util > 0.75 ? "hf-warn" : ""}`;

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
    totalDebt          += pos.debt * rs.priceUsd;
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

  // Borrow headroom: (collateral × cFactor − debt) × priceUsd
  // = how much more USD-worth can be borrowed before hitting HF = 1
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const headroomEl = $("pos-headroom");
  if (rs && rs.priceUsd > 0) {
    const maxDebt   = pos.collateral * rs.cFactor;    // in tokens
    const headroom  = Math.max(0, maxDebt - pos.debt) * rs.priceUsd;
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
  const c       = selectedAsset.cFactor;
  const hf      = hfForLeverage(lev, c);
  const rs      = reserves.find(r => r.asset.id === selectedAsset.id);

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

  const safe = hf >= 1.055 && selectedPool.status === 1 && liquidityOk;
  ($("hf-warning") as HTMLElement).classList.toggle("hidden", hf >= 1.055 || selectedPool.status !== 1);
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

  if (hfForLeverage(leverage, liveAsset.cFactor) < 1.055) { toast("HF too low — reduce leverage", "error"); return; }

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

async function connect() {
  try {
    const result = await StellarWalletsKit.authModal({ network: Networks.PUBLIC });
    userAddress  = result.address;
    $("wallet-address").textContent = fmtAddr(userAddress);
    $("connect-btn").classList.add("hidden");
    $("wallet-connected").classList.remove("hidden");
    $("connect-prompt").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
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
    if (result.address === userAddress) return; // same address, nothing to do
    userAddress = result.address;
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
  reserves    = [];
  positions   = { byAsset: new Map() };
  $("connect-btn").classList.remove("hidden");
  $("wallet-connected").classList.add("hidden");
  $("connect-prompt").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
}

// ── Event listeners ───────────────────────────────────────────────────────────

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
