/**
 * Blend CETES/USTRY/USDC/TESOURO/XLM Leverage UI
 */

import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { FreighterModule }   from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule }       from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule }      from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule }      from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule }        from "@creit-tech/stellar-wallets-kit/modules/hana";
import { Networks }          from "@creit-tech/stellar-wallets-kit/types";

import {
  ASSETS,
  NETWORK,
  fetchAllReserves,
  fetchUserPositions,
  fetchAssetBalance,
  fetchPendingBlnd,
  buildApproveXdr,
  buildOpenPositionXdr,
  buildClosePositionXdr,
  buildClaimXdr,
  submitSignedXdr,
  leverageAt,
  hfAt,
  type AssetInfo,
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
let selectedAsset: AssetInfo     = ASSETS[2]; // default: CETES

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const fmt  = (n: number, d = 2) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtAddr = (addr: string) => addr.slice(0, 6) + "…" + addr.slice(-4);
const fmtApr  = (n: number) => `${n >= 0 ? "+" : ""}${fmt(n, 2)}%`;

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

// ── Asset tabs ────────────────────────────────────────────────────────────────

function buildAssetTabs() {
  const container = $("asset-tabs");
  container.innerHTML = "";
  ASSETS.forEach(asset => {
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
  // Update tab active state
  document.querySelectorAll<HTMLButtonElement>(".asset-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["assetId"] === asset.id);
  });
  // Update input suffix
  ($("asset-symbol-suffix") as HTMLElement).textContent = asset.symbol;
  renderSelectedAsset();
  // Refresh balance + pending BLND for new asset
  if (userAddress) loadAll();
}

// ── Render reserve stats for selected asset ───────────────────────────────────

function renderSelectedAsset() {
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  if (!rs) return;

  // Pool stats bar
  const maxLev = 1 / (1 - rs.cFactor);
  $("stat-cfactor").textContent    = `${(rs.cFactor * 100).toFixed(0)}%`;
  $("stat-max-lev").textContent    = `${maxLev.toFixed(2)}×`;
  $("stat-liquidity").textContent  = `${fmt(rs.available, 0)} ${rs.asset.symbol}`;
  $("stat-price").textContent      = rs.priceUsd > 0 ? `$${fmt(rs.priceUsd, 4)}` : "—";

  // APR breakdown
  // Supply: interest + BLND
  renderAprLine("supply-interest-apr", rs.interestSupplyApr, false);
  renderAprLine("supply-blnd-apr",     rs.blndSupplyApr,     false, true);
  renderAprLine("supply-net-apr",      rs.netSupplyApr,      false);
  // Borrow: interest - BLND
  renderAprLine("borrow-interest-apr", rs.interestBorrowApr, true);
  renderAprLine("borrow-blnd-apr",     rs.blndBorrowApr,     false, true);
  renderAprLine("borrow-net-cost",     rs.netBorrowCost,     true);

  // Update leverage preview
  updatePreview();

  // Update position display for this asset
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

// ── Position display ──────────────────────────────────────────────────────────

function renderPosition() {
  const pos = positions.byAsset.get(selectedAsset.id);

  if (!pos) {
    $("no-position").classList.remove("hidden");
    $("position-data").classList.add("hidden");
    ($("close-btn") as HTMLButtonElement).disabled = true;
    return;
  }

  $("no-position").classList.add("hidden");
  $("position-data").classList.remove("hidden");
  ($("close-btn") as HTMLButtonElement).disabled = false;

  $("pos-collateral").textContent = `${fmt(pos.collateral, 4)} ${pos.asset.symbol}`;
  $("pos-debt").textContent       = `${fmt(pos.debt, 4)} ${pos.asset.symbol}`;
  $("pos-equity").textContent     = `${fmt(pos.equity, 4)} ${pos.asset.symbol}`;
  $("pos-leverage").textContent   = `${fmt(pos.leverage, 2)}×`;

  const hf = pos.hf;
  const hfEl = $("pos-hf");
  hfEl.textContent = isFinite(hf) ? fmt(hf, 3) : "∞";
  hfEl.className   = `metric-value ${hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad"}`;
  const barPct = Math.min(100, Math.max(0, (hf - 1) / 0.3 * 100));
  const bar = $("hf-bar");
  bar.style.width      = `${barPct}%`;
  bar.style.background = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";
}

// ── Leverage preview ──────────────────────────────────────────────────────────

function updatePreview() {
  const loops   = parseInt(($("loops-slider") as HTMLInputElement).value);
  const initial = parseFloat(($("initial-input") as HTMLInputElement).value) || 0;
  const c   = selectedAsset.cFactor;
  const lev = leverageAt(loops, c);
  const hf  = hfAt(loops, c);
  const rs  = reserves.find(r => r.asset.id === selectedAsset.id);

  $("loops-display").textContent    = String(loops);
  $("prev-lev").textContent         = `${lev.toFixed(2)}×`;
  $("prev-supply").textContent      = `${fmt(initial * lev, 2)} ${selectedAsset.symbol}`;
  $("prev-borrow").textContent      = `${fmt(initial * (lev - 1), 2)} ${selectedAsset.symbol}`;
  $("prev-hf").textContent          = fmt(hf, 3);
  $("prev-hf").className            = hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad";

  // Net APR at this leverage (supply side compounding, borrow side cost)
  if (rs) {
    const netApr = rs.netSupplyApr * lev - rs.netBorrowCost * (lev - 1);
    $("prev-net-apr").textContent = `${fmt(netApr, 2)}% APR`;
    $("prev-net-apr").className   = `prev-net-apr ${netApr > 0 ? "apr-great" : "apr-bad"}`;
  }

  const safe = hf >= 1.03;
  ($("hf-warning") as HTMLElement).classList.toggle("hidden", safe);
  ($("open-btn") as HTMLButtonElement).disabled = !safe;
}

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadAll() {
  if (!userAddress) return;
  try {
    reserves  = await fetchAllReserves(userAddress);
    positions = await fetchUserPositions(userAddress, reserves);

    // Update balance
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    $("asset-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;

    // Update pending BLND for selected asset
    const blnd = await fetchPendingBlnd(userAddress, selectedAsset);
    $("pos-blnd").textContent    = `${fmt(blnd, 4)} BLND`;
    ($("claim-btn") as HTMLButtonElement).disabled = blnd <= 0;

    renderSelectedAsset();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to load pool data:", e);
    toast(`Load failed: ${msg.slice(0, 120)}`, "error");
  }
}

async function refreshBalance() {
  if (!userAddress) return;
  const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
  $("asset-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function openPosition() {
  if (!userAddress) return;
  const initial = parseFloat(($("initial-input") as HTMLInputElement).value);
  const loops   = parseInt(($("loops-slider") as HTMLInputElement).value);
  if (isNaN(initial) || initial <= 0) { toast("Enter a valid amount", "error"); return; }
  if (hfAt(loops, selectedAsset.cFactor) < 1.03) { toast("HF too low — reduce loops", "error"); return; }

  const initialStroops = BigInt(Math.round(initial * 1e7));
  setLoading($("open-btn") as HTMLButtonElement, true);
  try {
    const approveXdr = await buildApproveXdr(userAddress, selectedAsset.id, initialStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${selectedAsset.symbol}`);
    const submitXdr = await buildOpenPositionXdr(userAddress, selectedAsset, initialStroops, loops);
    await signAndSubmit(submitXdr, `Open ${selectedAsset.symbol} leverage`);
    await loadAll();
  } catch (e: any) {
    toast(e?.message ?? "Transaction failed", "error");
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
    const { approveXdr, submitXdr } = await buildClosePositionXdr(userAddress, pos);
    await signAndSubmit(approveXdr, `Approve ${selectedAsset.symbol} (close buffer)`);
    await signAndSubmit(submitXdr, `Close ${selectedAsset.symbol} position`);
    await loadAll();
  } catch (e: any) {
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("close-btn") as HTMLButtonElement, false);
  }
}

async function claimBlnd() {
  if (!userAddress) return;
  setLoading($("claim-btn") as HTMLButtonElement, true);
  try {
    const claimXdr = await buildClaimXdr(userAddress, selectedAsset);
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

// ── Wallet connect / disconnect ───────────────────────────────────────────────

async function connect() {
  try {
    const result = await StellarWalletsKit.authModal({ network: Networks.PUBLIC });
    userAddress  = result.address;
    $("wallet-address").textContent = fmtAddr(userAddress);
    $("connect-btn").classList.add("hidden");
    $("wallet-connected").classList.remove("hidden");
    $("connect-prompt").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    buildAssetTabs();
    await loadAll();
  } catch (e: any) {
    if (e?.message !== "User closed the modal") toast("Failed to connect wallet", "error");
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
$("disconnect-btn").addEventListener("click", disconnect);
$("refresh-btn").addEventListener("click",    () => loadAll());
$("open-btn").addEventListener("click",       openPosition);
$("close-btn").addEventListener("click",      closePosition);
$("claim-btn").addEventListener("click",      claimBlnd);

($("loops-slider")  as HTMLInputElement).addEventListener("input",  updatePreview);
($("initial-input") as HTMLInputElement).addEventListener("input",  () => { refreshBalance(); updatePreview(); });
($("initial-input") as HTMLInputElement).addEventListener("change", () => { refreshBalance(); updatePreview(); });

// Init preview with defaults
updatePreview();
