/**
 * Blend CETES Leverage UI — main entry point.
 */

import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { FreighterModule }   from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule }       from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule }      from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule }      from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule }        from "@creit-tech/stellar-wallets-kit/modules/hana";
import { Networks }          from "@creit-tech/stellar-wallets-kit/types";

import {
  NETWORK,
  fetchPoolStats,
  fetchPosition,
  fetchCetesBalance,
  fetchPendingBlnd,
  buildApproveXdr,
  buildOpenPositionXdr,
  buildClosePositionXdr,
  buildClaimXdr,
  submitSignedXdr,
  leverageAt,
  hfAt,
  type Position,
} from "./blend.ts";

// ── Init wallet kit ───────────────────────────────────────────────────────────

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
let cFactor = 8_000_000n; // default — overwritten by live pool fetch
let position: Position | null = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

const connectBtn    = $("connect-btn")    as HTMLButtonElement;
const disconnectBtn = $("disconnect-btn") as HTMLButtonElement;
const walletConnected = $("wallet-connected");
const walletAddress  = $("wallet-address");
const connectPrompt  = $("connect-prompt");
const dashboard      = $("dashboard");

const noPosition   = $("no-position");
const positionData = $("position-data");
const refreshBtn   = $("refresh-btn")  as HTMLButtonElement;
const openBtn      = $("open-btn")     as HTMLButtonElement;
const closeBtn     = $("close-btn")    as HTMLButtonElement;
const claimBtn     = $("claim-btn")    as HTMLButtonElement;

const initialInput  = $("initial-input")  as HTMLInputElement;
const loopsSlider   = $("loops-slider")   as HTMLInputElement;
const loopsDisplay  = $("loops-display");
const prevLev       = $("prev-lev");
const prevHf        = $("prev-hf");
const prevSupply    = $("prev-supply");
const prevBorrow    = $("prev-borrow");
const hfWarning     = $("hf-warning");
const cetesBalance  = $("cetes-balance");

// stats bar
const statCfactor   = $("stat-cfactor");
const statMaxLev    = $("stat-max-lev");
const statLiquidity = $("stat-liquidity");
const statBorrowApr = $("stat-borrow-apr");
const statSupplyApr = $("stat-supply-apr");

// position
const posCollateral = $("pos-collateral");
const posDebt       = $("pos-debt");
const posEquity     = $("pos-equity");
const posLeverage   = $("pos-leverage");
const posHf         = $("pos-hf");
const posBlnd       = $("pos-blnd");
const hfBar         = $("hf-bar");

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtAddr = (addr: string) => addr.slice(0, 6) + "…" + addr.slice(-4);

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, type: "info" | "success" | "error", txHash?: string) {
  const toast   = $("toast");
  const msgEl   = $("toast-msg");
  const iconEl  = $("toast-icon");
  const linkEl  = $("toast-link") as HTMLAnchorElement;

  toast.className = `toast toast-${type === "error" ? "error" : type === "success" ? "success" : ""}`;
  iconEl.textContent = type === "success" ? "✓" : type === "error" ? "✗" : "⟳";
  msgEl.textContent  = msg;

  if (txHash) {
    linkEl.href = `https://stellar.expert/explorer/public/tx/${txHash}`;
    linkEl.classList.remove("hidden");
  } else {
    linkEl.classList.add("hidden");
  }

  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), type === "error" ? 8000 : 5000);
}

// ── Sign + submit helper ──────────────────────────────────────────────────────

async function signAndSubmit(xdrStr: string, label: string): Promise<string> {
  showToast(`Sign "${label}" in your wallet…`, "info");
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdrStr, {
    networkPassphrase: NETWORK,
    address: userAddress!,
  });
  showToast(`Submitting "${label}"…`, "info");
  const hash = await submitSignedXdr(signedTxXdr);
  showToast(`"${label}" confirmed!`, "success", hash);
  return hash;
}

// ── Pool stats ────────────────────────────────────────────────────────────────

async function loadPoolStats() {
  try {
    const stats = await fetchPoolStats(userAddress!);
    cFactor = stats.cFactor;
    const maxLev = 1 / (1 - stats.cFactorPct / 100);
    statCfactor.textContent   = `${stats.cFactorPct.toFixed(0)}%`;
    statMaxLev.textContent    = `${maxLev.toFixed(2)}×`;
    statLiquidity.textContent = `${fmt(stats.availableUsdc, 0)} CETES`;
    statBorrowApr.textContent = `${fmt(stats.borrowApr, 2)}%`;
    statSupplyApr.textContent = `${fmt(stats.supplyApr, 2)}%`;
  } catch (e) {
    console.error("Failed to load pool stats:", e);
  }
}

// ── Position ──────────────────────────────────────────────────────────────────

async function loadPosition() {
  if (!userAddress) return;
  try {
    position = await fetchPosition(userAddress);
    const blnd  = await fetchPendingBlnd(userAddress);
    const bal   = await fetchCetesBalance(userAddress);

    cetesBalance.textContent = fmt(bal, 4);

    if (!position) {
      noPosition.classList.remove("hidden");
      positionData.classList.add("hidden");
      closeBtn.disabled = true;
      claimBtn.disabled = blnd <= 0;
      posBlnd.textContent = fmt(blnd, 4);
      return;
    }

    noPosition.classList.add("hidden");
    positionData.classList.remove("hidden");

    posCollateral.textContent = fmt(position.collateralCetes, 2);
    posDebt.textContent       = fmt(position.debtCetes, 2);
    posEquity.textContent     = fmt(position.equity, 4);
    posLeverage.textContent   = fmt(position.leverage, 2);
    posBlnd.textContent       = fmt(blnd, 4);

    // HF display
    const hf = position.hf;
    posHf.textContent = hf > 10 ? "∞" : fmt(hf, 3);
    posHf.className = `metric-value ${hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad"}`;
    const barPct = Math.min(100, Math.max(0, (hf - 1) / 0.3 * 100));
    hfBar.style.width = `${barPct}%`;
    hfBar.style.background = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";

    closeBtn.disabled = false;
    claimBtn.disabled = blnd <= 0;
  } catch (e) {
    console.error("Failed to load position:", e);
  }
}

// ── Leverage preview (open form) ──────────────────────────────────────────────

function updatePreview() {
  const loops = parseInt(loopsSlider.value);
  const initial = parseFloat(initialInput.value) || 0;
  const c = Number(cFactor) / 1e7;
  const lev = leverageAt(loops, c);
  const hf  = hfAt(loops, c);
  const totalSupply = initial * lev;
  const totalBorrow = totalSupply - initial;

  loopsDisplay.textContent = String(loops);
  prevLev.textContent    = `${lev.toFixed(2)}×`;
  prevSupply.textContent = `${fmt(totalSupply, 0)} CETES`;
  prevBorrow.textContent = `${fmt(totalBorrow, 0)} CETES`;
  prevHf.textContent     = fmt(hf, 3);
  prevHf.className       = hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad";

  if (hf < 1.03) {
    hfWarning.classList.remove("hidden");
    openBtn.disabled = true;
  } else {
    hfWarning.classList.add("hidden");
    openBtn.disabled = false;
  }
}

// ── Wallet connect ────────────────────────────────────────────────────────────

async function connect() {
  try {
    const result = await StellarWalletsKit.authModal({ network: Networks.PUBLIC });
    userAddress = result.address;
    walletAddress.textContent = fmtAddr(userAddress);
    connectBtn.classList.add("hidden");
    walletConnected.classList.remove("hidden");
    connectPrompt.classList.add("hidden");
    dashboard.classList.remove("hidden");
    await Promise.all([loadPoolStats(), loadPosition()]);
  } catch (e: any) {
    if (e?.message !== "User closed the modal") showToast("Failed to connect wallet", "error");
  }
}

async function disconnect() {
  await StellarWalletsKit.disconnect();
  userAddress = null;
  position = null;
  connectBtn.classList.remove("hidden");
  walletConnected.classList.add("hidden");
  connectPrompt.classList.remove("hidden");
  dashboard.classList.add("hidden");
}

// ── Open position ─────────────────────────────────────────────────────────────

async function openPosition() {
  if (!userAddress) return;
  const initial = parseFloat(initialInput.value);
  const loops   = parseInt(loopsSlider.value);
  if (isNaN(initial) || initial <= 0) { showToast("Enter a valid CETES amount", "error"); return; }
  if (hfAt(loops, Number(cFactor) / 1e7) < 1.03) { showToast("Too risky — reduce loops", "error"); return; }

  const initialStroops = BigInt(Math.round(initial * 1e7));
  setLoading(openBtn, true);
  try {
    // Tx 1: approve
    const approveXdr = await buildApproveXdr(userAddress, initialStroops + 1n);
    await signAndSubmit(approveXdr, "Approve CETES");

    // Tx 2: open position
    const submitXdr = await buildOpenPositionXdr(userAddress, initialStroops, cFactor, loops);
    await signAndSubmit(submitXdr, "Open leverage position");

    await loadPosition();
  } catch (e: any) {
    showToast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading(openBtn, false);
  }
}

// ── Close position ────────────────────────────────────────────────────────────

async function closePosition() {
  if (!userAddress || !position) return;
  setLoading(closeBtn, true);
  try {
    const { approveXdr, submitXdr } = await buildClosePositionXdr(userAddress, position);
    // Approve in case net flow is slightly negative due to accrued interest
    await signAndSubmit(approveXdr, "Approve CETES (close buffer)");
    await signAndSubmit(submitXdr, "Close leverage position");
    await loadPosition();
  } catch (e: any) {
    showToast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading(closeBtn, false);
  }
}

// ── Claim BLND ────────────────────────────────────────────────────────────────

async function claimBlnd() {
  if (!userAddress) return;
  setLoading(claimBtn, true);
  try {
    const claimXdr = await buildClaimXdr(userAddress);
    await signAndSubmit(claimXdr, "Claim BLND emissions");
    await loadPosition();
  } catch (e: any) {
    showToast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading(claimBtn, false);
  }
}

// ── Loading state helper ──────────────────────────────────────────────────────

function setLoading(btn: HTMLButtonElement, on: boolean) {
  btn.disabled = on;
  if (on) btn.classList.add("btn-loading");
  else     btn.classList.remove("btn-loading");
}

// ── Event listeners ───────────────────────────────────────────────────────────

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
refreshBtn.addEventListener("click", () => { loadPoolStats(); loadPosition(); });
openBtn.addEventListener("click", openPosition);
closeBtn.addEventListener("click", closePosition);
claimBtn.addEventListener("click", claimBlnd);
loopsSlider.addEventListener("input", updatePreview);
initialInput.addEventListener("input", updatePreview);

// Init preview
updatePreview();
