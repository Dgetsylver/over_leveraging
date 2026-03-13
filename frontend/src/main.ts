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
  buildIncreaseLeverageXdr,
  buildDecreaseLeverageXdr,
  buildResupplyXdr,
  buildSwapBlndXdr,
  estimateBlndSwap,
  submitSignedXdr,
  submitClassicXdr,
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

// ── Demo mode ────────────────────────────────────────────────────────────────

let demoMode = false;

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const fmt  = (n: number, d = 2) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtAddr = (addr: string) => addr.slice(0, 6) + "…" + addr.slice(-4);

// ── Skeleton loading (#3) ────────────────────────────────────────────────────

function setSkeleton(id: string) {
  const el = $(id);
  el.textContent = "\u00A0\u00A0\u00A0\u00A0\u00A0";
  el.classList.add("skeleton");
}
function clearSkeleton(id: string) { $(id).classList.remove("skeleton"); }

// ── Data freshness (#4) ─────────────────────────────────────────────────────

let lastRefreshTime = 0;
let freshnessInterval: ReturnType<typeof setInterval> | null = null;
let autoRefreshInterval: ReturnType<typeof setInterval> | null = null;

function updateFreshnessDisplay() {
  if (!lastRefreshTime) return;
  const secs = Math.round((Date.now() - lastRefreshTime) / 1000);
  const el = $("data-freshness");
  if (secs < 5) { el.textContent = "Just now"; }
  else if (secs < 60) { el.textContent = `${secs}s ago`; }
  else { el.textContent = `${Math.floor(secs / 60)}m ago`; }
  el.classList.toggle("stale", secs > 60);
}

function startFreshnessTimer() {
  lastRefreshTime = Date.now();
  if (freshnessInterval) clearInterval(freshnessInterval);
  freshnessInterval = setInterval(updateFreshnessDisplay, 5000);
  updateFreshnessDisplay();
  // Auto-refresh after 60s
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(() => { if (userAddress && !demoMode) loadAll(); }, 60_000);
}

// ── Animated number transitions (#11) ────────────────────────────────────────

function animateNumber(el: HTMLElement, to: number, duration = 400, formatFn: (n: number) => string = (n) => fmt(n, 2)) {
  const fromText = el.textContent?.replace(/[^\d.\-]/g, "") ?? "0";
  const from = parseFloat(fromText) || 0;
  if (Math.abs(from - to) < 0.001) { el.textContent = formatFn(to); return; }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = formatFn(to); return;
  }
  const start = performance.now();
  function frame(now: number) {
    const t = Math.min(1, (now - start) / duration);
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    el.textContent = formatFn(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Toast stack (#20) ────────────────────────────────────────────────────────

let _toastCounter = 0;
function toast(msg: string, type: "info" | "success" | "error", hash?: string) {
  const stack = $("toast-stack");
  // Remove oldest if already 3
  while (stack.children.length >= 3) stack.removeChild(stack.firstChild!);
  const id = `toast-${++_toastCounter}`;
  const el = document.createElement("div");
  el.id = id;
  el.className = `toast toast-${type}`;
  el.setAttribute("role", "alert");
  const icon = type === "success" ? "\u2713" : type === "error" ? "\u2717" : "\u27F3";
  const linkHtml = hash
    ? ` <a class="toast-link" href="https://stellar.expert/explorer/public/tx/${hash}" target="_blank" rel="noopener">View \u2192</a>`
    : "";
  el.innerHTML = `<span>${icon}</span><span>${msg}</span>${linkHtml}`;
  stack.appendChild(el);
  const timeout = type === "error" ? 9000 : 5000;
  setTimeout(() => { const t = document.getElementById(id); if (t) t.remove(); }, timeout);
}

// ── TX History (#16) ─────────────────────────────────────────────────────────

const TX_HISTORY_KEY = "blendlev_tx_history";
const TX_HISTORY_MAX = 10;

function addTxToHistory(label: string, hash: string, status: "success" | "error") {
  const history = getTxHistory();
  history.unshift({ label, hash, status, time: Date.now() });
  if (history.length > TX_HISTORY_MAX) history.pop();
  localStorage.setItem(TX_HISTORY_KEY, JSON.stringify(history));
  renderTxHistory();
}

function getTxHistory(): Array<{ label: string; hash: string; status: string; time: number }> {
  const raw = localStorage.getItem(TX_HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

function renderTxHistory() {
  const list = $("tx-history-list");
  const history = getTxHistory();
  if (history.length === 0) { $("tx-history").style.display = "none"; return; }
  $("tx-history").style.display = "";
  list.innerHTML = history.map(tx => {
    const ago = Math.round((Date.now() - tx.time) / 60000);
    const timeStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
    return `<div class="tx-history-item">
      <span class="tx-history-status-${tx.status === "success" ? "ok" : "err"}">${tx.status === "success" ? "\u2713" : "\u2717"}</span>
      <span class="tx-history-label">${tx.label}</span>
      <span class="tx-history-time">${timeStr}</span>
      <a class="tx-history-link" href="https://stellar.expert/explorer/public/tx/${tx.hash}" target="_blank" rel="noopener">View</a>
    </div>`;
  }).join("");
}

// ── TX Stepper (#10) ─────────────────────────────────────────────────────────

let _stepperTimer: ReturnType<typeof setTimeout> | null = null;

function showTxStepper(steps: string[]) {
  const el = $("tx-stepper");
  el.innerHTML = steps.map((label, i) =>
    `${i > 0 ? '<div class="tx-step-connector"></div>' : ''}` +
    `<div class="tx-step" id="tx-step-${i}">` +
    `<span class="tx-step-num">${i + 1}</span>` +
    `<span>${label}</span></div>`
  ).join("");
  el.classList.remove("hidden");
  if (_stepperTimer) clearTimeout(_stepperTimer);
}

function updateTxStep(index: number, state: "active" | "done" | "error") {
  const step = document.getElementById(`tx-step-${index}`);
  if (!step) return;
  step.className = `tx-step ${state}`;
  const num = step.querySelector(".tx-step-num")!;
  if (state === "done") num.textContent = "\u2713";
  else if (state === "error") num.textContent = "\u2717";
  if (state === "active") {
    const existing = step.querySelector(".tx-step-spinner");
    if (!existing) { const sp = document.createElement("span"); sp.className = "tx-step-spinner"; step.appendChild(sp); }
  }
}

function hideTxStepper(delay = 3000) {
  _stepperTimer = setTimeout(() => $("tx-stepper").classList.add("hidden"), delay);
}

function markStepperError(totalSteps: number) {
  for (let i = 0; i < totalSteps; i++) {
    const s = document.getElementById(`tx-step-${i}`);
    if (s && !s.classList.contains("done")) { updateTxStep(i, "error"); break; }
  }
  hideTxStepper(6000);
}

// ── PnL tracking (#15) ──────────────────────────────────────────────────────

function savePnlEntry(assetId: string, poolId: string, deposit: number) {
  const key = `pnl_${poolId}_${assetId}`;
  localStorage.setItem(key, JSON.stringify({ deposit, timestamp: Date.now() }));
}
function getPnlEntry(assetId: string, poolId: string): { deposit: number; timestamp: number } | null {
  const raw = localStorage.getItem(`pnl_${poolId}_${assetId}`);
  return raw ? JSON.parse(raw) : null;
}
function removePnlEntry(assetId: string, poolId: string) {
  localStorage.removeItem(`pnl_${poolId}_${assetId}`);
}

// ── Sign + submit ─────────────────────────────────────────────────────────────

async function signAndSubmit(xdrStr: string, label: string, stepIndex?: number): Promise<string> {
  if (stepIndex !== undefined) updateTxStep(stepIndex, "active");
  toast(`Sign "${label}" in your wallet\u2026`, "info");
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdrStr, {
    networkPassphrase: NETWORK,
    address: userAddress!,
  });
  toast(`Submitting "${label}"\u2026`, "info");
  const hash = await submitSignedXdr(signedTxXdr);
  if (stepIndex !== undefined) updateTxStep(stepIndex, "done");
  toast(`"${label}" confirmed!`, "success", hash);
  addTxToHistory(label, hash, "success");
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
    btn.setAttribute("role", "tab");
    if (isFrozen) btn.setAttribute("data-tip", "Admin Frozen \u2014 exploited Feb 2026");
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

  renderPoolFooter();
  closeDrawer();

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
  // Gradient track (#9)
  slider.style.background = `linear-gradient(90deg, var(--success) 0%, var(--primary) 33%, var(--warning) 66%, var(--danger) 100%)`;
}

function buildAssetTabs() {
  const container = $("asset-tabs");
  container.innerHTML = "";
  assets.forEach(asset => {
    const btn = document.createElement("button");
    btn.className = `asset-tab ${asset.id === selectedAsset.id ? "active" : ""}`;
    btn.dataset["assetId"] = asset.id;
    btn.innerHTML = `<span class="tab-symbol">${asset.symbol}</span>`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", asset.id === selectedAsset.id ? "true" : "false");
    btn.addEventListener("click", () => selectAsset(asset));
    container.appendChild(btn);
  });
}

function selectAsset(asset: AssetInfo) {
  selectedAsset = asset;
  document.querySelectorAll<HTMLButtonElement>(".asset-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["assetId"] === asset.id);
    btn.setAttribute("aria-selected", btn.dataset["assetId"] === asset.id ? "true" : "false");
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

// ── HF Gauge (#7) ────────────────────────────────────────────────────────────

function renderHFGauge(hf: number): string {
  const cx = 60, cy = 55, r = 45;
  const clampedHF = Math.max(1.0, Math.min(1.3, isFinite(hf) ? hf : 1.3));
  const pct = (clampedHF - 1.0) / 0.3;
  const angle = Math.PI * (1 - pct);
  const nx = cx + r * Math.cos(angle);
  const ny = cy - r * Math.sin(angle);
  const color = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";
  const textColor = hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad";
  const bgArc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const largeArc = pct > 0.5 ? 1 : 0;
  const fillArc = `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${nx.toFixed(1)} ${ny.toFixed(1)}`;

  return `<svg class="hf-gauge" viewBox="0 0 120 65" width="120" height="65">
    <path d="${bgArc}" fill="none" stroke="var(--hf-bar-bg)" stroke-width="8" stroke-linecap="round"/>
    <path d="${fillArc}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
    <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="${color}"/>
    <text x="${cx}" y="${cy + 2}" text-anchor="middle" class="hf-gauge-text ${textColor}">${isFinite(hf) ? fmt(hf, 3) : "\u221E"}</text>
  </svg>`;
}

// ── Liquidation countdown ring (#18) ─────────────────────────────────────────

function renderLiqCountdownRing(days: number, maxDays = 365): string {
  const r = 18, cx = 22, cy = 22, stroke = 4;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, days / maxDays));
  const offset = circumference * (1 - pct);
  const color = days < 7 ? "var(--danger)" : days < 30 ? "var(--warning)" : "var(--success)";
  const pulse = days < 7 ? ' class="liq-ring-pulse"' : '';
  return `<svg width="44" height="44" viewBox="0 0 44 44"${pulse}>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--hf-bar-bg)" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"/>
  </svg>`;
}

// ── APY Chart (#14) ──────────────────────────────────────────────────────────

function renderApyChart(rs: ReserveStats | undefined, currentLev: number) {
  const container = $("apy-chart");
  if (!rs) { container.innerHTML = ""; return; }
  const maxLev = parseFloat(($("leverage-slider") as HTMLInputElement).max);
  const W = 300, H = 70, padL = 30, padR = 10, padT = 5, padB = 15;
  const steps: { lev: number; apy: number }[] = [];
  for (let l = 1.1; l <= maxLev; l += 0.2) {
    steps.push({ lev: l, apy: rs.netSupplyApr * l - rs.netBorrowCost * (l - 1) });
  }
  if (steps.length < 2) { container.innerHTML = ""; return; }
  const minApy = Math.min(0, ...steps.map(s => s.apy));
  const maxApy = Math.max(1, ...steps.map(s => s.apy));
  const rangeApy = maxApy - minApy || 1;
  const x = (lev: number) => padL + (lev - 1.1) / (maxLev - 1.1) * (W - padL - padR);
  const y = (apy: number) => padT + (1 - (apy - minApy) / rangeApy) * (H - padT - padB);
  const points = steps.map(s => `${x(s.lev).toFixed(1)},${y(s.apy).toFixed(1)}`).join(" ");
  const curApy = rs.netSupplyApr * currentLev - rs.netBorrowCost * (currentLev - 1);
  const zeroY = y(0);

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" class="apy-chart-zero"/>
    <polyline points="${points}" class="apy-chart-line"/>
    <circle cx="${x(currentLev).toFixed(1)}" cy="${y(curApy).toFixed(1)}" r="4" class="apy-chart-dot"/>
    <text x="${padL - 2}" y="${padT + 8}" text-anchor="end" class="apy-chart-label">${fmt(maxApy, 0)}%</text>
    <text x="${padL - 2}" y="${H - padB + 2}" text-anchor="end" class="apy-chart-label">${fmt(minApy, 0)}%</text>
    <text x="${x(currentLev).toFixed(1)}" y="${Number(y(curApy).toFixed(1)) - 8}" text-anchor="middle" class="apy-chart-label">${fmt(curApy, 1)}%</text>
  </svg>`;
}

// ── Render reserve stats for selected asset ───────────────────────────────────

function renderSelectedAsset() {
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  if (!rs) return;

  // Clear skeletons (#3)
  ["stat-cfactor","stat-max-lev","stat-liquidity","stat-util","stat-price",
   "supply-interest-apr","supply-blnd-apr","supply-net-apr","borrow-interest-apr","borrow-blnd-apr","borrow-net-cost"]
    .forEach(clearSkeleton);

  updateLeverageSlider(rs.cFactor, rs.lFactor);

  const maxLev = maxLeverageFor(rs.cFactor, rs.lFactor, minHF());
  $("stat-cfactor").textContent    = `${(rs.cFactor * 100).toFixed(0)}%`;
  $("stat-max-lev").textContent    = `${maxLev.toFixed(2)}\u00D7`;
  $("stat-liquidity").textContent  = `${fmt(rs.available, 0)} ${rs.asset.symbol}`;

  // Utilization display with color coding
  const util = rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;
  const utilEl = $("stat-util");
  utilEl.textContent = `${(util * 100).toFixed(1)}%`;
  utilEl.className = `stat-value ${util > 0.90 ? "hf-bad" : util > 0.75 ? "hf-warn" : ""}`;

  // Utilization bar (#13)
  const utilBar = $("util-bar");
  utilBar.style.width = `${(util * 100).toFixed(1)}%`;
  utilBar.style.background = util > 0.90 ? "var(--danger)" : util > 0.75 ? "var(--warning)" : "var(--success)";

  $("stat-price").textContent      = rs.priceUsd > 0 ? `$${fmt(rs.priceUsd, 4)}` : "\u2014";

  renderAprLine("supply-interest-apr", rs.interestSupplyApr, false);
  renderAprLine("supply-blnd-apr",     rs.blndSupplyApr,     false, true);
  renderAprLine("supply-net-apr",      rs.netSupplyApr,      false);
  renderAprLine("borrow-interest-apr", rs.interestBorrowApr, true);
  renderAprLine("borrow-blnd-apr",     rs.blndBorrowApr,     false, true);
  renderAprLine("borrow-net-cost",     rs.netBorrowCost,     true);

  // Auto-collapse stats when position exists (#23)
  const hasPosition = positions.byAsset.has(selectedAsset.id);
  $("stats-collapsible").classList.toggle("collapsed", hasPosition);

  updatePreview();
  renderPosition();
  renderPortfolioSummary();
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

// ── Portfolio summary (#8) ───────────────────────────────────────────────────

function renderPortfolioSummary() {
  const container = $("portfolio-summary");
  if (positions.byAsset.size === 0) { container.classList.add("hidden"); return; }
  container.classList.remove("hidden");
  container.innerHTML = "";
  for (const [assetId, pos] of positions.byAsset) {
    const rs = reserves.find(r => r.asset.id === assetId);
    const netApr = rs ? rs.netSupplyApr * pos.leverage - rs.netBorrowCost * (pos.leverage - 1) : 0;
    const hfColor = pos.hf > 1.1 ? "var(--success)" : pos.hf > 1.03 ? "var(--warning)" : "var(--danger)";
    const card = document.createElement("div");
    card.className = `portfolio-card ${assetId === selectedAsset.id ? "active" : ""}`;
    card.innerHTML = `
      <span class="portfolio-card-hf-dot" style="background:${hfColor};box-shadow:0 0 6px ${hfColor}"></span>
      <span class="portfolio-card-symbol">${pos.asset.symbol}</span>
      <span class="portfolio-card-details">
        <span>${fmt(pos.equity, 2)} equity \u00B7 ${fmt(pos.leverage, 1)}\u00D7</span>
        <span>APY ${netApr >= 0 ? "+" : ""}${fmt(netApr, 1)}% \u00B7 HF ${fmt(pos.hf, 2)}</span>
      </span>`;
    card.addEventListener("click", () => {
      const asset = assets.find(a => a.id === assetId);
      if (asset) selectAsset(asset);
    });
    container.appendChild(card);
  }
}

// ── Pool footer (#19) ────────────────────────────────────────────────────────

function renderPoolFooter() {
  const footer = $("pool-footer");
  const addr = selectedPool.id;
  const truncated = addr.slice(0, 6) + "\u2026" + addr.slice(-4);
  footer.innerHTML = `
    <span>Pool: <a href="https://stellar.expert/explorer/public/contract/${addr}" target="_blank" rel="noopener" class="mono">${truncated}</a></span>
    <span>\u00B7</span>
    <a href="https://docs.blend.capital/" target="_blank" rel="noopener">Blend Docs</a>
    <span>\u00B7</span>
    <a href="https://github.com/blend-capital" target="_blank" rel="noopener">GitHub</a>
  `;
}

// ── Position display ──────────────────────────────────────────────────────────

function renderPosition() {
  const pos = positions.byAsset.get(selectedAsset.id);

  if (!pos) {
    $("no-position").classList.remove("hidden");
    $("position-data").classList.add("hidden");
    ($("close-btn") as HTMLButtonElement).disabled = true;
    ($("repay-btn") as HTMLButtonElement).disabled = true;
    ($("resupply-btn") as HTMLButtonElement).disabled = true;
    // Show Open mode
    setActionCardMode("open");
    return;
  }

  // Clear position skeletons (#3)
  ["pos-collateral","pos-debt","pos-equity","pos-leverage","pos-hf","pos-pool-hf","pos-net-apr","pos-headroom","pos-liq-days"]
    .forEach(clearSkeleton);

  $("no-position").classList.add("hidden");
  $("position-data").classList.remove("hidden");
  ($("close-btn") as HTMLButtonElement).disabled = false;
  ($("repay-btn") as HTMLButtonElement).disabled = pos.dTokens === 0n;
  ($("resupply-btn") as HTMLButtonElement).disabled = false;
  // Show Adjust mode
  setActionCardMode("adjust", pos);

  $("pos-collateral").textContent = `${fmt(pos.collateral, 4)} ${pos.asset.symbol}`;
  $("pos-debt").textContent       = `${fmt(pos.debt, 4)} ${pos.asset.symbol}`;

  // Equity with PnL (#15)
  const pnl = getPnlEntry(selectedAsset.id, selectedPool.id);
  if (pnl) {
    const unrealizedPnl = pos.equity - pnl.deposit;
    const pnlPct = pnl.deposit > 0 ? (unrealizedPnl / pnl.deposit * 100) : 0;
    const pnlColor = unrealizedPnl >= 0 ? "hf-ok" : "hf-bad";
    $("pos-equity").innerHTML = `${fmt(pos.equity, 4)} ${pos.asset.symbol} <span class="${pnlColor}" style="font-size:11px">(${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 4)} / ${unrealizedPnl >= 0 ? "+" : ""}${fmt(pnlPct, 1)}%)</span>`;
  } else {
    $("pos-equity").textContent     = `${fmt(pos.equity, 4)} ${pos.asset.symbol}`;
  }

  // Animated leverage (#11)
  animateNumber($("pos-leverage"), pos.leverage, 400, n => `${fmt(n, 2)}\u00D7`);

  // Per-asset health factor with icon (#22)
  const hf = pos.hf;
  const hfEl = $("pos-hf");
  const hfIcon = hf > 1.1 ? "\u2713" : hf > 1.03 ? "\u26A0" : "\u2717";
  hfEl.textContent = `${hfIcon} ${isFinite(hf) ? fmt(hf, 3) : "\u221E"}`;
  hfEl.className   = `metric-value ${hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad"}`;
  const barPct = Math.min(100, Math.max(0, (hf - 1) / 0.3 * 100));
  const bar = $("hf-bar");
  bar.style.width      = `${barPct}%`;
  bar.style.background = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";

  // ARIA on HF bar (#6)
  const barWrap = $("hf-bar").parentElement!;
  barWrap.setAttribute("aria-valuenow", String(Math.round(barPct)));
  barWrap.setAttribute("aria-label", `Health factor ${isFinite(hf) ? fmt(hf, 3) : "infinity"}`);

  // HF Gauge (#7)
  const gaugeEl = document.querySelector(".hf-gauge-container") as HTMLElement;
  if (gaugeEl) gaugeEl.innerHTML = renderHFGauge(hf);

  // HF warning banner (#2)
  const warnEl = $("hf-pos-warning");
  if (isFinite(hf) && hf < 1.1) {
    const isDanger = hf < 1.03;
    warnEl.className = `hf-pos-warning ${isDanger ? "hf-danger-level" : "hf-warn-level"}`;
    warnEl.innerHTML = `
      <span>${isDanger ? "\u2717" : "\u26A0"} Health Factor is ${fmt(hf, 3)} \u2014 ${isDanger ? "liquidation imminent!" : "approaching liquidation"}</span>
      <div class="hf-warn-actions">
        <button class="btn btn-sm btn-secondary" onclick="document.getElementById('repay-btn').click()">Repay</button>
        <button class="btn btn-sm btn-secondary" onclick="document.getElementById('resupply-btn').click()">Resupply</button>
      </div>`;
    warnEl.classList.remove("hidden");
  } else {
    warnEl.classList.add("hidden");
  }

  // Pool-wide health factor with icon (#22)
  const poolHF   = computePoolHF();
  const poolHFEl = $("pos-pool-hf");
  const poolIcon = poolHF > 1.1 ? "\u2713" : poolHF > 1.03 ? "\u26A0" : "\u2717";
  poolHFEl.textContent = `${poolIcon} ${isFinite(poolHF) ? fmt(poolHF, 3) : "\u221E"}`;
  poolHFEl.className   = `metric-value ${poolHF > 1.1 ? "hf-ok" : poolHF > 1.03 ? "hf-warn" : "hf-bad"}`;

  // Borrow headroom
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const headroomEl = $("pos-headroom");
  if (rs && rs.priceUsd > 0) {
    const effectiveCollateral = pos.collateral * rs.cFactor;
    const effectiveDebt       = pos.debt / rs.lFactor;
    const headroom  = Math.max(0, effectiveCollateral - effectiveDebt) * rs.priceUsd;
    headroomEl.textContent = `$${fmt(headroom, 2)}`;
    headroomEl.className   = `metric-value mono ${headroom < 5 ? "hf-bad" : headroom < 20 ? "hf-warn" : ""}`;
  } else {
    headroomEl.textContent = "\u2014";
    headroomEl.className   = "metric-value mono";
  }

  // Net APY with icon (#22)
  const netAprEl = $("pos-net-apr");
  if (rs && pos.leverage > 0) {
    const netApr = rs.netSupplyApr * pos.leverage - rs.netBorrowCost * (pos.leverage - 1);
    const aprIcon = netApr > 0 ? "\u2713" : "\u2717";
    netAprEl.textContent = `${aprIcon} ${netApr >= 0 ? "+" : ""}${fmt(netApr, 2)}%`;
    netAprEl.className   = `metric-value ${netApr > 0 ? "hf-ok" : "hf-bad"}`;
  } else {
    netAprEl.textContent = "\u2014";
    netAprEl.className   = "metric-value";
  }

  // Days until liquidation with ring (#18)
  const liqDaysEl  = $("pos-liq-days");
  const liqNoteEl  = $("pos-liq-note");
  if (rs && pos.leverage > 0 && isFinite(pos.hf) && pos.hf > 1) {
    const spreadPct = rs.interestBorrowApr - rs.interestSupplyApr;
    if (spreadPct <= 0) {
      liqDaysEl.textContent = "Never (supply APR \u2265 borrow APR)";
      liqDaysEl.className   = "metric-value hf-ok";
      liqNoteEl.textContent = "";
    } else {
      const daysLeft = Math.log(pos.hf) / (spreadPct / 100) * 365;
      if (daysLeft <= 365) {
        liqDaysEl.innerHTML = `<span class="liq-countdown-wrap">${renderLiqCountdownRing(daysLeft)} <span>~${Math.round(daysLeft)} days</span></span>`;
      } else {
        liqDaysEl.textContent = daysLeft > 3650 ? ">10 years" : `~${Math.round(daysLeft)} days`;
      }
      liqDaysEl.className   = `metric-value ${daysLeft < 30 ? "hf-bad" : daysLeft < 90 ? "hf-warn" : "hf-ok"}`;
      liqNoteEl.textContent = `Interest spread: ${fmt(spreadPct, 2)}%/yr (borrow \u2212 supply). Claim & convert BLND to extend runway.`;
    }
  } else {
    liqDaysEl.textContent = "\u2014";
    liqDaysEl.className   = "metric-value";
    liqNoteEl.textContent = "";
  }

  // Compound row: show swap estimate if there's pending BLND
  updateCompoundEstimate();
}

async function updateCompoundEstimate() {
  const compoundBtn = $("compound-btn") as HTMLButtonElement;
  const estimateEl  = $("compound-estimate");

  // Check pending BLND from the displayed value
  const blndText = $("pos-blnd").textContent ?? "";
  const blndMatch = blndText.match(/([\d.]+)/);
  const pendingBlnd = blndMatch ? parseFloat(blndMatch[1]) : 0;

  if (pendingBlnd <= 0 || !positions.byAsset.has(selectedAsset.id)) {
    estimateEl.textContent = "";
    compoundBtn.disabled = true;
    return;
  }

  estimateEl.textContent = "\u2192 estimating\u2026";
  compoundBtn.disabled = true;

  try {
    const est = await estimateBlndSwap(pendingBlnd, selectedAsset.id);
    if (est) {
      estimateEl.textContent = `\u2192 ~${fmt(est.estimate, 4)} ${selectedAsset.symbol}`;
      compoundBtn.disabled = false;
    } else {
      estimateEl.textContent = "(no swap path)";
      compoundBtn.disabled = true;
    }
  } catch {
    estimateEl.textContent = "";
    compoundBtn.disabled = true;
  }
}

// ── Open / Adjust mode switching ──────────────────────────────────────────

let actionMode: "open" | "adjust" = "open";

function setActionCardMode(mode: "open" | "adjust", pos?: AssetPosition) {
  actionMode = mode;
  const isAdjust = mode === "adjust";

  $("action-card-title").textContent = isAdjust ? "Adjust Position" : "Open Position";
  $("open-deposit-group").classList.toggle("hidden", isAdjust);
  $("adjust-current").classList.toggle("hidden", !isAdjust);
  $("open-btn").classList.toggle("hidden", isAdjust);
  $("adjust-btn").classList.toggle("hidden", !isAdjust);
  $("open-disclaimer").classList.toggle("hidden", isAdjust);
  $("adjust-disclaimer").classList.toggle("hidden", !isAdjust);

  if (isAdjust && pos) {
    $("adjust-current-lev").textContent = `${fmt(pos.leverage, 2)}\u00D7`;
    $("leverage-label").textContent = "Target leverage";
    // Set slider to current leverage
    const slider = $("leverage-slider") as HTMLInputElement;
    const numIn  = $("leverage-input")  as HTMLInputElement;
    const curLev = Math.round(pos.leverage * 10) / 10;
    slider.value = String(curLev);
    numIn.value  = curLev.toFixed(1);
  } else {
    $("leverage-label").innerHTML = 'Leverage <span class="tooltip" data-tip="Multiplier on your deposit. Higher leverage amplifies both yield and liquidation risk.">?</span>';
    initTooltips(); // Re-init tooltips for newly created elements
  }
  updatePreview();
}

// ── Leverage preview ──────────────────────────────────────────────────────────

function updatePreview() {
  const slider = $("leverage-slider") as HTMLInputElement;
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const lev    = parseFloat(slider.value) || 1.1;
  // Keep the number input in sync with the slider
  if (parseFloat(numIn.value) !== lev) numIn.value = lev.toFixed(1);
  const rs      = reserves.find(r => r.asset.id === selectedAsset.id);
  const c       = rs ? rs.cFactor : selectedAsset.cFactor;
  const l       = rs?.lFactor ?? 1;
  const hf      = hfForLeverage(lev, c, l);
  const pos     = positions.byAsset.get(selectedAsset.id);

  // In adjust mode, use equity as the base; in open mode, use initial deposit
  const equity  = (actionMode === "adjust" && pos) ? pos.equity : (parseFloat(($("initial-input") as HTMLInputElement).value) || 0);
  const supply  = equity * lev;
  const borrow  = equity * (lev - 1);

  $("prev-lev").textContent         = `${lev.toFixed(2)}\u00D7`;
  $("prev-supply").textContent      = `${fmt(supply, 2)} ${selectedAsset.symbol}`;
  $("prev-borrow").textContent      = `${fmt(borrow, 2)} ${selectedAsset.symbol}`;
  $("prev-hf").textContent          = isFinite(hf) ? fmt(hf, 3) : "\u221E";
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
      prevLiqEl.textContent = "\u2014";
      prevLiqEl.className   = "";
    }

    // APY chart (#14)
    renderApyChart(rs, lev);
  }

  // Risk zone labels (#9)
  const zones = document.querySelectorAll<HTMLElement>(".slider-zone");
  zones.forEach(z => {
    const zone = z.dataset.zone;
    const active =
      (zone === "conservative" && lev >= 1.1 && lev < 3) ||
      (zone === "moderate" && lev >= 3 && lev < 6) ||
      (zone === "aggressive" && lev >= 6 && lev < 9) ||
      (zone === "degen" && lev >= 9);
    z.classList.toggle("active", !!active);
  });

  // Liquidity check (only for open mode and increase in adjust mode)
  const liquidityWarnEl = $("liquidity-warning") as HTMLElement;
  let liquidityOk = true;
  if (actionMode === "open") {
    const initial = equity;
    const totalBorrow = initial * (lev - 1);
    const cf = rs ? rs.cFactor : selectedAsset.cFactor;
    const firstBorrow = Math.min(initial * cf, totalBorrow);
    const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
    liquidityOk = !rs || firstBorrow <= poolAvailAfterDeposit;
    if (!liquidityOk && rs) {
      liquidityWarnEl.textContent = `\u26A0 First borrow (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol}). Reduce leverage or deposit.`;
      liquidityWarnEl.classList.remove("hidden");
    } else {
      liquidityWarnEl.classList.add("hidden");
    }
  } else {
    liquidityWarnEl.classList.add("hidden");
  }

  const safe = hf >= minHF() && selectedPool.status === 1 && liquidityOk;
  ($("hf-warning") as HTMLElement).classList.toggle("hidden", hf >= minHF() || selectedPool.status !== 1);
  ($("open-btn") as HTMLButtonElement).disabled = !safe;

  // Adjust button: enabled if leverage changed and HF is safe
  if (actionMode === "adjust" && pos) {
    const curLev = Math.round(pos.leverage * 10) / 10;
    const changed = Math.abs(lev - curLev) >= 0.1;
    ($("adjust-btn") as HTMLButtonElement).disabled = !safe || !changed;
    ($("adjust-btn") as HTMLButtonElement).textContent =
      lev > curLev ? `Increase to ${lev.toFixed(1)}\u00D7` :
      lev < curLev ? `Decrease to ${lev.toFixed(1)}\u00D7` :
      "Adjust Leverage";
  }
}

// ── Load data ─────────────────────────────────────────────────────────────────

let _loadInProgress = false;

async function loadAll() {
  if (!userAddress || _loadInProgress) return;
  _loadInProgress = true;

  // Show skeletons (#3)
  const skeletonIds = ["stat-cfactor","stat-max-lev","stat-liquidity","stat-util","stat-price",
    "supply-interest-apr","supply-blnd-apr","supply-net-apr","borrow-interest-apr","borrow-blnd-apr","borrow-net-cost",
    "pos-collateral","pos-debt","pos-equity","pos-leverage","pos-hf","pos-pool-hf","pos-net-apr","pos-headroom","pos-liq-days"];
  skeletonIds.forEach(setSkeleton);

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
    startFreshnessTimer();
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
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  if (selectedPool.status !== 1) { toast("Pool is frozen \u2014 cannot open new positions", "error"); return; }
  const initial  = parseFloat(($("initial-input") as HTMLInputElement).value);
  const leverage = parseFloat(($("leverage-slider") as HTMLInputElement).value);
  if (isNaN(initial) || initial <= 0) { toast("Enter a valid amount", "error"); return; }

  // Use live cFactor from reserves so intermediate borrow steps don't exceed pool limits
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const liveAsset = rs?.asset ?? selectedAsset;

  if (hfForLeverage(leverage, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) { toast("HF too low \u2014 reduce leverage", "error"); return; }

  const totalBorrow   = initial * (leverage - 1);
  const firstBorrow   = Math.min(initial * liveAsset.cFactor, totalBorrow);
  const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
  if (rs && firstBorrow > poolAvailAfterDeposit) {
    toast(`First borrow step (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol}). Reduce leverage.`, "error");
    return;
  }

  const initialStroops = BigInt(Math.round(initial * 1e7));
  setLoading($("open-btn") as HTMLButtonElement, true);
  showTxStepper(["Approve", "Submit"]);
  try {
    const approveXdr = await buildApproveXdr(selectedPool, userAddress, liveAsset.id, initialStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${liveAsset.symbol}`, 0);
    const submitXdr = await buildOpenPositionXdr(selectedPool, userAddress, liveAsset, initialStroops, leverage);
    await signAndSubmit(submitXdr, `Open ${liveAsset.symbol} leverage`, 1);
    hideTxStepper();
    savePnlEntry(liveAsset.id, selectedPool.id, initial);
    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    const msg: string = e?.message ?? "Transaction failed";
    if (msg.includes("#1205") || msg.includes("InvalidHf")) {
      toast("Health factor too low \u2014 reduce leverage.", "error");
    } else if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) {
      toast("Pool utilization limit reached \u2014 not enough liquidity for this borrow. Reduce leverage or deposit.", "error");
    } else {
      toast(msg.slice(0, 200), "error");
    }
  } finally {
    setLoading($("open-btn") as HTMLButtonElement, false);
  }
}

async function closePosition() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;
  setLoading($("close-btn") as HTMLButtonElement, true);
  showTxStepper(["Close Position"]);
  try {
    const submitXdr = await buildCloseSubmitXdr(selectedPool, userAddress, pos);
    await signAndSubmit(submitXdr, `Close ${selectedAsset.symbol} position`, 0);
    hideTxStepper();
    removePnlEntry(selectedAsset.id, selectedPool.id);
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("close-btn") as HTMLButtonElement, false);
  }
}

async function repayDebt() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos || pos.dTokens === 0n) return;
  setLoading($("repay-btn") as HTMLButtonElement, true);
  showTxStepper(["Repay Debt"]);
  try {
    const repayXdr = await buildRepayXdr(selectedPool, userAddress, pos);
    await signAndSubmit(repayXdr, `Repay ${selectedAsset.symbol} debt`, 0);
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
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
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  // Collect all token IDs for ALL positions in this pool
  const tokenIds: number[] = [];
  for (const pos of positions.byAsset.values()) {
    if (pos.bTokens > 0n) tokenIds.push(pos.asset.supplyTokenId);
    if (pos.dTokens > 0n) tokenIds.push(pos.asset.borrowTokenId);
  }
  if (tokenIds.length === 0) { toast("No positions to claim from", "error"); return; }

  setLoading($("claim-btn") as HTMLButtonElement, true);
  showTxStepper(["Claim BLND"]);
  try {
    const claimXdr = await buildClaimXdr(selectedPool, userAddress, tokenIds);
    await signAndSubmit(claimXdr, "Claim BLND", 0);
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("claim-btn") as HTMLButtonElement, false);
  }
}

/** Adjust leverage on an existing position (increase or decrease). */
async function adjustLeverage() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  const targetLev = parseFloat(($("leverage-slider") as HTMLInputElement).value);
  const curLev = pos.leverage;
  if (Math.abs(targetLev - curLev) < 0.05) { toast("Target leverage is same as current", "error"); return; }

  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const liveAsset = rs?.asset ?? selectedAsset;

  if (hfForLeverage(targetLev, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) {
    toast("HF too low at target leverage \u2014 reduce target", "error");
    return;
  }

  setLoading($("adjust-btn") as HTMLButtonElement, true);
  const direction = targetLev > curLev ? "Increase" : "Decrease";
  showTxStepper([`${direction} Leverage`]);
  try {
    if (targetLev > curLev) {
      const xdr = await buildIncreaseLeverageXdr(selectedPool, userAddress, liveAsset, pos, targetLev);
      await signAndSubmit(xdr, `Increase leverage to ${targetLev.toFixed(1)}\u00D7`, 0);
    } else {
      const xdr = await buildDecreaseLeverageXdr(selectedPool, userAddress, liveAsset, pos, targetLev);
      await signAndSubmit(xdr, `Decrease leverage to ${targetLev.toFixed(1)}\u00D7`, 0);
    }
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
    toast(e?.message ?? "Adjust leverage failed", "error");
  } finally {
    setLoading($("adjust-btn") as HTMLButtonElement, false);
  }
}

/** Resupply: deposit entire wallet balance of the position asset as extra collateral. */
async function resupply() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
  if (bal <= 0) { toast(`No ${selectedAsset.symbol} in wallet to resupply`, "error"); return; }

  const amountStroops = BigInt(Math.round(bal * 1e7));
  setLoading($("resupply-btn") as HTMLButtonElement, true);
  showTxStepper(["Approve", "Resupply"]);
  try {
    const approveXdr = await buildApproveXdr(selectedPool, userAddress, selectedAsset.id, amountStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${selectedAsset.symbol}`, 0);

    const supplyXdr = await buildResupplyXdr(selectedPool, userAddress, selectedAsset.id, amountStroops);
    await signAndSubmit(supplyXdr, `Resupply ${fmt(bal, 4)} ${selectedAsset.symbol}`, 1);
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    toast(e?.message ?? "Resupply failed", "error");
  } finally {
    setLoading($("resupply-btn") as HTMLButtonElement, false);
  }
}

/** Claim BLND from pool, then swap to the selected asset via Stellar DEX path payment. */
async function claimAndConvert() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  // Step 1: Claim BLND
  const tokenIds: number[] = [];
  for (const p of positions.byAsset.values()) {
    if (p.bTokens > 0n) tokenIds.push(p.asset.supplyTokenId);
    if (p.dTokens > 0n) tokenIds.push(p.asset.borrowTokenId);
  }
  if (tokenIds.length === 0) { toast("No positions to claim from", "error"); return; }

  setLoading($("compound-btn") as HTMLButtonElement, true);
  showTxStepper(["Claim BLND", "Swap"]);
  try {
    // Claim
    const claimXdr = await buildClaimXdr(selectedPool, userAddress, tokenIds);
    await signAndSubmit(claimXdr, "Claim BLND", 0);

    // Check actual BLND balance after claim
    const blndBalance = await fetchAssetBalance(userAddress, "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY");
    if (blndBalance <= 0) { toast("No BLND to convert", "error"); hideTxStepper(1000); await loadAll(); return; }

    // Step 2: Swap BLND -> position asset via DEX path payment (classic tx)
    updateTxStep(1, "active");
    toast(`Swapping ${fmt(blndBalance, 2)} BLND \u2192 ${selectedAsset.symbol}\u2026`, "info");
    const { xdr: swapXdr, estimate } = await buildSwapBlndXdr(
      userAddress,
      blndBalance,
      selectedAsset.id,
      swapSlippage,
    );
    // Sign via wallet kit
    toast(`Sign swap in your wallet\u2026`, "info");
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(swapXdr, {
      networkPassphrase: NETWORK,
      address: userAddress!,
    });
    toast(`Submitting swap\u2026`, "info");
    const swapHash = await submitClassicXdr(signedTxXdr);
    updateTxStep(1, "done");
    toast(`Converted ${fmt(blndBalance, 2)} BLND \u2192 ~${estimate} ${selectedAsset.symbol}`, "success");
    addTxToHistory(`Swap BLND \u2192 ${selectedAsset.symbol}`, swapHash, "success");
    hideTxStepper();

    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    toast(e?.message ?? "Claim & Convert failed", "error");
  } finally {
    setLoading($("compound-btn") as HTMLButtonElement, false);
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
    renderPoolFooter();
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
  closeDrawer();
}

// ── Mobile sidebar drawer (#5) ───────────────────────────────────────────

function closeDrawer() {
  document.querySelector(".sidebar")!.classList.remove("open");
  $("sidebar-backdrop").classList.add("hidden");
}

// ── Swap assets ──────────────────────────────────────────────────────────

// Swap assets use classic Stellar CODE-ISSUER format (not Soroban contract addresses)
const SWAP_ASSETS: { symbol: string; brokerId: string }[] = [
  { symbol: "XLM",     brokerId: "XLM" },
  { symbol: "USDC",    brokerId: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { symbol: "EURC",    brokerId: "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
  { symbol: "AQUA",    brokerId: "AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
  { symbol: "BLND",    brokerId: "BLND-GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY" },
  { symbol: "yXLM",    brokerId: "yXLM-GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55" },
  { symbol: "USDGLO",  brokerId: "USDGLO-GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV" },
];

function getSwapAssetList(): { symbol: string; brokerId: string }[] {
  const seen = new Set(SWAP_ASSETS.map(a => a.symbol));
  const list = [...SWAP_ASSETS];
  return list;
}

function populateSwapAssets() {
  const sellSelect = $("swap-sell-asset") as HTMLSelectElement;
  const buySelect  = $("swap-buy-asset") as HTMLSelectElement;
  if (sellSelect.options.length > 0) return; // already populated

  const list = getSwapAssetList();
  list.forEach(a => {
    sellSelect.add(new Option(a.symbol, a.brokerId));
    buySelect.add(new Option(a.symbol, a.brokerId));
  });
  // Defaults: sell XLM, buy USDC
  sellSelect.value = "XLM";
  const usdcAsset = list.find(a => a.symbol === "USDC");
  if (usdcAsset) {
    buySelect.value = usdcAsset.brokerId;
  } else {
    buySelect.selectedIndex = 1;
  }
}

let _quoteTimer: ReturnType<typeof setTimeout> | null = null;
let _lastQuote: any = null;
let swapSlippage = 0.02;

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
      sellingAsset: sellAsset,
      buyingAsset: buyAsset,
      sellingAmount: sellAmount,
      slippageTolerance: swapSlippage,
    });

    _lastQuote = quote;

    if (quote.status === "success" && quote.estimatedBuyingAmount) {
      ($("swap-buy-amount") as HTMLInputElement).placeholder = "\u2014";
      ($("swap-buy-amount") as HTMLInputElement).value = parseFloat(quote.estimatedBuyingAmount).toFixed(7);

      const sellNum = parseFloat(sellAmount);
      const buyNum  = parseFloat(quote.estimatedBuyingAmount);
      const sellSym = ($("swap-sell-asset") as HTMLSelectElement).selectedOptions[0].text;
      const buySym  = ($("swap-buy-asset") as HTMLSelectElement).selectedOptions[0].text;

      $("swap-rate").textContent = `1 ${sellSym} \u2248 ${(buyNum / sellNum).toFixed(6)} ${buySym}`;
      $("swap-direct").textContent = quote.directTrade
        ? `${parseFloat(quote.directTrade.buying).toFixed(7)} ${buySym}`
        : "\u2014";
      $("swap-profit").textContent = quote.profit ? `${quote.profit}` : "\u2014";
      $("swap-quote-details").classList.remove("hidden");
    } else {
      ($("swap-buy-amount") as HTMLInputElement).value = quote.status === "unfeasible" ? "No route" : "\u2014";
      $("swap-quote-details").classList.add("hidden");
      _lastQuote = null;
    }
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    ($("swap-buy-amount") as HTMLInputElement).value = "";
    ($("swap-buy-amount") as HTMLInputElement).placeholder = "Quote unavailable";
    $("swap-quote-details").classList.add("hidden");
    _lastQuote = null;
    console.warn("Swap quote:", errMsg);
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

// ── Tooltip popovers (#1) ────────────────────────────────────────────────────

function initTooltips() {
  const popover = $("tooltip-popover");
  document.querySelectorAll<HTMLElement>(".tooltip").forEach(el => {
    const tip = el.getAttribute("title") || el.dataset.tip || "";
    el.removeAttribute("title");
    el.dataset.tip = tip;

    el.addEventListener("mouseenter", () => {
      popover.textContent = tip;
      const rect = el.getBoundingClientRect();
      popover.style.left = `${rect.left + rect.width / 2}px`;
      popover.style.top = `${rect.bottom + 8}px`;
      popover.style.transform = "translateX(-50%)";
      popover.classList.add("visible");
    });
    el.addEventListener("mouseleave", () => popover.classList.remove("visible"));
    // Mobile: toggle on click
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      popover.textContent = tip;
      const rect = el.getBoundingClientRect();
      popover.style.left = `${rect.left + rect.width / 2}px`;
      popover.style.top = `${rect.bottom + 8}px`;
      popover.style.transform = "translateX(-50%)";
      popover.classList.toggle("visible");
    });
  });
  // Also handle data-tip on non-.tooltip elements (buttons, etc.)
  document.querySelectorAll<HTMLElement>("[data-tip]:not(.tooltip)").forEach(el => {
    const tip = el.dataset.tip || "";
    el.removeAttribute("title");

    el.addEventListener("mouseenter", () => {
      popover.textContent = tip;
      const rect = el.getBoundingClientRect();
      popover.style.left = `${rect.left + rect.width / 2}px`;
      popover.style.top = `${rect.bottom + 8}px`;
      popover.style.transform = "translateX(-50%)";
      popover.classList.add("visible");
    });
    el.addEventListener("mouseleave", () => popover.classList.remove("visible"));
  });
  document.addEventListener("click", () => popover.classList.remove("visible"));
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

// Mobile hamburger (#5)
$("hamburger-btn").addEventListener("click", () => {
  document.querySelector(".sidebar")!.classList.add("open");
  $("sidebar-backdrop").classList.remove("hidden");
});
$("sidebar-backdrop").addEventListener("click", closeDrawer);

// Mobile card tabs (#12)
document.querySelectorAll<HTMLButtonElement>(".mobile-card-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mobile-card-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const panel = btn.dataset.panel;
    const cards = document.querySelectorAll<HTMLElement>(".two-col > .card");
    if (window.innerWidth <= 900) {
      cards[0]?.classList.toggle("mobile-hidden", panel !== "position");
      cards[1]?.classList.toggle("mobile-hidden", panel !== "action");
    }
  });
});

// Collapsible stats (#23)
$("stats-toggle").addEventListener("click", () => {
  $("stats-collapsible").classList.toggle("collapsed");
});

// Slippage selector
document.querySelectorAll(".slippage-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".slippage-opt").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    (document.getElementById("slippage-custom-input") as HTMLInputElement).value = "";
    swapSlippage = parseFloat((btn as HTMLElement).dataset.slip!);
    debounceQuote();
  });
});
$("slippage-custom-input").addEventListener("input", () => {
  const val = parseFloat(($("slippage-custom-input") as HTMLInputElement).value);
  if (val > 0 && val <= 50) {
    document.querySelectorAll(".slippage-opt").forEach(b => b.classList.remove("active"));
    swapSlippage = val / 100;
    debounceQuote();
  }
});

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

// Map broker asset ID back to Soroban contract ID for balance lookups
const BROKER_TO_CONTRACT: Record<string, string> = {
  "XLM": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IBER": "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
  "AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA": "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
};

async function updateSwapBalance() {
  if (!userAddress) return;
  const sellBrokerId = ($("swap-sell-asset") as HTMLSelectElement).value;
  const contractId = BROKER_TO_CONTRACT[sellBrokerId];
  if (!contractId) { $("swap-sell-balance").textContent = "\u2014"; return; }
  try {
    const bal = await fetchAssetBalance(userAddress, contractId);
    const sym = ($("swap-sell-asset") as HTMLSelectElement).selectedOptions[0].text;
    $("swap-sell-balance").textContent = `${fmt(bal, 4)} ${sym}`;
  } catch { $("swap-sell-balance").textContent = "\u2014"; }
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
$("compound-btn").addEventListener("click",   claimAndConvert);
$("resupply-btn").addEventListener("click",   resupply);
$("adjust-btn").addEventListener("click",    adjustLeverage);

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

// ── Demo mode (#17) ──────────────────────────────────────────────────────────

$("demo-btn").addEventListener("click", () => {
  demoMode = true;
  userAddress = "GDEMO000000000000000000000000000000000000000000000000000";
  showConnected();
  $("wallet-address").textContent = "Demo Mode";
  $("switch-wallet-btn").classList.add("hidden");
  // Load mock reserves and positions
  reserves = assets.map(a => ({
    asset: a, cFactor: a.cFactor, lFactor: 1, interestSupplyApr: 4.2, interestBorrowApr: 6.8,
    blndSupplyApr: 2.1, blndBorrowApr: 1.5, netSupplyApr: 6.3, netBorrowCost: 5.3,
    totalSupply: 1000000, totalBorrow: 650000, available: 350000, priceUsd: 1.0,
  }));
  positions = { byAsset: new Map() };
  // One sample position
  const sampleAsset = assets[0];
  positions.byAsset.set(sampleAsset.id, {
    asset: sampleAsset, collateral: 5000, debt: 3000, equity: 2000,
    leverage: 2.5, hf: 1.15, bTokens: 50000000000n, dTokens: 30000000000n,
  } as AssetPosition);
  buildPoolTabs();
  buildAssetTabs();
  renderPoolFooter();
  $("asset-balance").textContent = "10,000.0000 " + selectedAsset.symbol;
  $("pos-blnd").textContent = "125.3400 BLND";
  renderSelectedAsset();
  toast("Demo mode \u2014 explore the UI without a wallet", "info");
});

// Init preview with defaults
updatePreview();
renderTxHistory();
renderPoolFooter();
initTooltips();

// ── Auto-reconnect saved wallet ──────────────────────────────────────────────
(async () => {
  const saved = localStorage.getItem("walletAddress");
  if (!saved) return;
  userAddress = saved;
  showConnected();
  buildPoolTabs();
  buildAssetTabs();
  renderPoolFooter();
  await loadAll();
})();
