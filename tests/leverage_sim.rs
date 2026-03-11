use blend_contract_sdk::pool;
use soroban_ledger_snapshot_source_tx::{Network, TxSnapshotSource};
use soroban_sdk::{token::TokenClient, Address, Env};

/// Etherfuse pool on Blend Protocol (Stellar mainnet)
const POOL_ID: &str = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";

/// User address to inspect for existing positions
const USER_ADDR: &str = "GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA";

/// Stellar mainnet ledger to fork from (fetched 2026-03-11)
const MAINNET_LEDGER: u32 = 61_605_613;

/// All Blend v2 config/rate values are scaled by 1e7
const SCALAR: f64 = 1e7;

// ─── Interest rate model ──────────────────────────────────────────────────────
//
// Blend v2 uses a three-kink interest rate curve.
// All curve params (r_base, r_one, r_two, r_three, util, max_util) are 1e7-scaled.
//
// borrow_apr = curve(utilization) × ir_mod
// supply_apr = borrow_apr × utilization × (1 − backstop_take_rate)
//
fn compute_rates(
    reserve: &pool::Reserve,
    bstop_rate: f64, // backstop take rate, 0–1
) -> (f64, f64) {
    let cfg = &reserve.config;

    // Current utilization  (SCALAR cancels → dimensionless ratio)
    let total_borrows = reserve.b_supply as f64 * reserve.b_rate as f64;
    let total_supply = reserve.d_supply as f64 * reserve.d_rate as f64;
    let util = if total_supply > 0.0 {
        total_borrows / total_supply
    } else {
        0.0
    };

    let util_target = cfg.util as f64 / SCALAR;
    let max_util = cfg.max_util as f64 / SCALAR;
    let r_base = cfg.r_base as f64 / SCALAR;
    let r_one = cfg.r_one as f64 / SCALAR;
    let r_two = cfg.r_two as f64 / SCALAR;
    let r_three = cfg.r_three as f64 / SCALAR;

    let base_rate = if util <= util_target {
        r_base + r_one * util / util_target
    } else if util <= max_util {
        r_base + r_one + r_two * (util - util_target) / (max_util - util_target)
    } else {
        r_base + r_one + r_two + r_three * (util - max_util) / (1.0 - max_util)
    };

    let ir_mod = reserve.ir_mod as f64 / SCALAR;
    let borrow_apr = base_rate * ir_mod;
    let supply_apr = borrow_apr * util * (1.0 - bstop_rate);

    (supply_apr, borrow_apr)
}

// ─── Leverage math ────────────────────────────────────────────────────────────
//
// Strategy: supply USDC as collateral → borrow USDC (up to c_factor × collateral)
//           → re-supply → repeat.
//
// After n loops starting from `initial`:
//   total_supplied(n) = initial × (1 − c^(n+1)) / (1 − c)
//   total_borrowed(n) = total_supplied(n) − initial
//   leverage(n)       = total_supplied(n) / initial
//   health_factor(n)  = (total_supplied × c) / total_borrowed
//
// Maximum (n → ∞):
//   leverage_max      = 1 / (1 − c)          e.g. c=0.95 → 20×
//   health_factor_min = 1.0000               (razor thin)
//
// Since both supplied and borrowed asset are USDC:
//   HF is independent of price → no oracle-based liquidation risk.
//
fn leverage(n: usize, c: f64) -> f64 {
    (1.0 - c.powi(n as i32 + 1)) / (1.0 - c)
}

#[test]
fn simulate_usdc_leverage() {
    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║    Blend Protocol · Etherfuse Pool · USDC Loop Sim      ║");
    println!("╚══════════════════════════════════════════════════════════╝");

    // ── 1. Fork Stellar mainnet ───────────────────────────────────────────────
    println!("\n[1/4] Forking mainnet at ledger {}…", MAINNET_LEDGER);
    println!("      (first run fetches from Stellar RPC and caches locally)");

    let source = TxSnapshotSource::new(Network::mainnet(None), MAINNET_LEDGER, None);
    let env = Env::from_ledger_snapshot(source);

    // ── 2. Connect to pool ────────────────────────────────────────────────────
    let pool_addr = Address::from_str(&env, POOL_ID);
    let pool = pool::Client::new(&env, &pool_addr);

    let pool_cfg = pool.get_config();
    let bstop_rate = pool_cfg.bstop_rate as f64 / SCALAR;

    // ── 3. Discover USDC reserve ──────────────────────────────────────────────
    println!("[2/4] Reading pool reserves…");

    let reserve_list = pool.get_reserve_list();
    println!("\n  Pool assets ({} total):", reserve_list.len());

    let mut usdc_addr: Option<Address> = None;
    for i in 0..reserve_list.len() {
        let asset = reserve_list.get(i).unwrap();
        let token = TokenClient::new(&env, &asset);
        let symbol = token.symbol();
        let is_usdc = symbol == soroban_sdk::String::from_str(&env, "USDC");
        println!(
            "    [{}] {:?}{}",
            i,
            asset,
            if is_usdc { "  ◄ USDC" } else { "" }
        );
        if is_usdc {
            usdc_addr = Some(asset);
        }
    }

    let usdc = usdc_addr.expect("USDC not found among pool reserves");

    // ── 4. Read USDC reserve data ─────────────────────────────────────────────
    println!("\n[3/4] Reading USDC reserve…");
    let reserve = pool.get_reserve(&usdc);
    let cfg = &reserve.config;

    let c_factor = cfg.c_factor as f64 / SCALAR;
    let l_factor = cfg.l_factor as f64 / SCALAR;

    let (supply_apr, borrow_apr) = compute_rates(&reserve, bstop_rate);

    let util = {
        let borrows = reserve.b_supply as f64 * reserve.b_rate as f64;
        let supply = reserve.d_supply as f64 * reserve.d_rate as f64;
        if supply > 0.0 {
            borrows / supply
        } else {
            0.0
        }
    };

    println!("\n  ┌──────────────────────────────────────┐");
    println!("  │ USDC Reserve (live from mainnet fork) │");
    println!("  ├──────────────────────────────────────┤");
    println!("  │  Collateral factor (c):  {:>7.1}%    │", c_factor * 100.0);
    println!("  │  Liquidation factor:     {:>7.1}%    │", l_factor * 100.0);
    println!("  │  Utilization:            {:>7.2}%    │", util * 100.0);
    println!("  │  Supply APR:             {:>7.2}%    │", supply_apr * 100.0);
    println!("  │  Borrow APR:             {:>7.2}%    │", borrow_apr * 100.0);
    println!("  │  Backstop take rate:     {:>7.1}%    │", bstop_rate * 100.0);
    println!("  │  IR modifier:            {:>8.4}    │", reserve.ir_mod as f64 / SCALAR);
    println!("  └──────────────────────────────────────┘");

    // ── 5. Show user's current positions ─────────────────────────────────────
    let user = Address::from_str(&env, USER_ADDR);
    let positions = pool.get_positions(&user);
    println!("\n  User positions ({}…{}):",
        &USER_ADDR[..6], &USER_ADDR[USER_ADDR.len()-4..]);
    if positions.collateral.is_empty() && positions.liabilities.is_empty() {
        println!("    None — using hypothetical $1,000 USDC for simulation below");
    } else {
        println!("    Collateral positions:  {}", positions.collateral.len());
        println!("    Liability positions:   {}", positions.liabilities.len());
    }

    // ── 6. Leverage simulation ────────────────────────────────────────────────
    println!("\n[4/4] Simulating leverage loops…\n");

    let initial = 1_000.0_f64;
    let max_lev = 1.0 / (1.0 - c_factor);

    println!("  Initial deposit:          ${:.0}", initial);
    println!("  Collateral factor (c):     {:.0}%  (borrow up to c × collateral)", c_factor * 100.0);
    println!("  Max theoretical leverage:  {:.2}×  (= 1 / (1 − c))", max_lev);
    println!("  Max leveraged exposure:   ${:.0}", initial * max_lev);

    println!();
    println!("  {:>4}  {:>14}  {:>14}  {:>9}  {:>13}  {:>14}",
        "Loop", "Supplied  ($)", "Borrowed  ($)", "Leverage", "Health Factor", "Net APY");
    println!("  {}", "─".repeat(75));

    let mut last_safe_loops = 0usize;

    for n in 0usize..=60 {
        let lev = leverage(n, c_factor);
        let supplied = initial * lev;
        let borrowed = supplied - initial;
        let hf_str = if borrowed > 0.0 {
            format!("{:.4}", (supplied * c_factor) / borrowed)
        } else {
            "      ∞".to_string()
        };

        let net_yield = supply_apr * supplied - borrow_apr * borrowed;
        let net_apy = net_yield / initial * 100.0;

        println!("  {:>4}  {:>14.2}  {:>14.2}  {:>8.2}×  {:>13}  {:>13.2}%",
            n, supplied, borrowed, lev, hf_str, net_apy);

        // Track loops where HF stays >= 1.05
        let hf = if borrowed > 0.0 { (supplied * c_factor) / borrowed } else { f64::INFINITY };
        if hf >= 1.05 {
            last_safe_loops = n;
        }

        if lev / max_lev > 0.9999 {
            break;
        }
    }

    // Theoretical infinity row
    let max_sup = initial * max_lev;
    let max_bor = max_sup - initial;
    let max_net_apy = (supply_apr * max_sup - borrow_apr * max_bor) / initial * 100.0;
    println!("  {}", "─".repeat(75));
    println!("  {:>4}  {:>14.2}  {:>14.2}  {:>8.2}×  {:>13.4}  {:>13.2}%",
        "∞", max_sup, max_bor, max_lev, 1.0_f64, max_net_apy);

    // ── 7. Liquidation risk analysis ──────────────────────────────────────────
    println!();
    println!("  ┌─────────────────────────────────────────────────────────┐");
    println!("  │                 Liquidation Risk Analysis               │");
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!("  │  Borrowed asset:  USDC                                  │");
    println!("  │  Collateral:      USDC  (same asset)                    │");
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!("  │  ✓ Price risk: NONE                                      │");
    println!("  │    HF = (supplied × c) / borrowed — price-independent   │");
    println!("  │    USDC/USDC always = 1.0 in the oracle                 │");
    println!("  ├─────────────────────────────────────────────────────────┤");

    let safe_lev = leverage(last_safe_loops, c_factor);
    println!("  │  Safe max: {} loops → {:.2}× leverage (HF ≥ 1.05)  │",
        last_safe_loops,
        safe_lev,
    );
    println!("  │  At 20× max: HF → 1.0000 — one accrual tick risks liq  │");
    println!("  ├─────────────────────────────────────────────────────────┤");

    if supply_apr > borrow_apr {
        println!("  │  ✓ Rate spread: +{:.2}%  (strategy earns yield)         │",
            (supply_apr - borrow_apr) * 100.0);
        println!("  │    Max net APY at {:.0}×: {:.2}%                         │",
            max_lev, max_net_apy);
    } else {
        println!("  │  ✗ Borrow APR ({:.2}%) > Supply APR ({:.2}%)           │",
            borrow_apr * 100.0, supply_apr * 100.0);
        println!("  │    Leverage COSTS money right now — do not loop!        │");
    }

    println!("  └─────────────────────────────────────────────────────────┘");
    println!();
}
