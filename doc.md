# Blend Protocol — USDC Leverage Loop Simulation

Simulates the maximum leverage achievable by looping USDC supply/borrow on the
[Blend Protocol](https://blend.capital) Etherfuse pool on Stellar mainnet, using a
live mainnet fork via [`soroban-ledger-snapshot-source-tx`](https://github.com/stellar/rs-soroban-sdk/pull/1657).

## Strategy

```
Supply USDC as collateral
       ↓
Borrow USDC (up to c_factor × collateral)
       ↓
Re-supply borrowed USDC
       ↓
Repeat until position reaches theoretical maximum
```

**Pool:** `CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI`

## Math

With collateral factor `c = 0.95`:

| After n loops | Formula |
|---|---|
| Total supplied | `initial × (1 − cⁿ⁺¹) / (1 − c)` |
| Total borrowed | `total_supplied − initial` |
| Leverage | `total_supplied / initial` |
| Health factor | `(total_supplied × c) / total_borrowed` |
| Net APY on initial | `(supply_rate × supplied − borrow_rate × borrowed) / initial` |

**Maximum leverage** (n → ∞):

```
leverage_max = 1 / (1 − c) = 1 / (1 − 0.95) = 20×
```

## Liquidation Risk

Since **both collateral and borrowed asset are USDC**, the health factor is:

```
HF = (supplied × c) / borrowed
```

This is **independent of USDC price** — the oracle always prices USDC/USDC = 1.0.
There is **no traditional price-based liquidation risk**.

Remaining risks at high leverage:
- **Rate risk**: if borrow APR rises above supply APR, the position bleeds
- **HF at 20×**: approaches 1.0000 — any interest accrual imbalance could trigger liquidation
- **Smart contract / pool solvency risk**

Recommended safe maximum: **~13–15 loops** to maintain HF ≥ 1.05.

## How It Works

The simulation uses [`soroban-ledger-snapshot-source-tx`](https://github.com/stellar/rs-soroban-sdk/pull/1657)
to fork Stellar mainnet state at a specific ledger, then:

1. Connects to the Etherfuse pool contract via `blend-contract-sdk`
2. Reads all pool reserves via `pool.get_reserve_list()`
3. Identifies USDC by token symbol
4. Reads USDC reserve config: collateral factor, IR curve params
5. Computes current supply/borrow APR from the Blend v2 kinked interest rate model
6. Iterates the loop strategy for n = 0..∞ and prints the full table

### Interest Rate Model

Blend v2 uses a three-kink kinked rate curve:

```
if util ≤ util_target:
    borrow_rate = r_base + r_one × (util / util_target)
elif util ≤ max_util:
    borrow_rate = r_base + r_one + r_two × (util − util_target) / (max_util − util_target)
else:
    borrow_rate = r_base + r_one + r_two + r_three × (util − max_util) / (1 − max_util)

borrow_rate  ×= ir_mod
supply_rate   = borrow_rate × utilization × (1 − backstop_take_rate)
```

## Running

```bash
cargo test simulate_usdc_leverage -- --nocapture
```

The first run fetches ledger entries from Stellar mainnet RPC and caches them locally.
Subsequent runs use the cache and complete in seconds.

## Dependencies

| Crate | Source | Purpose |
|---|---|---|
| `soroban-ledger-snapshot-source-tx` | git (`snapshot-source-tx` branch) | Mainnet fork |
| `soroban-sdk` | crates.io v25 | Soroban test environment |
| `blend-contract-sdk` | crates.io v2.25.0 | Blend pool contract client |
