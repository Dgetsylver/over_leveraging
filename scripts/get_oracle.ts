/**
 * Read PoolConfig from each pool's persistent storage to get oracle address.
 */
import {
  StrKey,
  rpc as SorobanRpc,
  xdr,
  scValToNative,
  nativeToScVal,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://rpc.lightsail.network/";
const server  = new SorobanRpc.Server(RPC_URL);
const bigIntReplacer = (_: string, v: any) => typeof v === "bigint" ? v.toString() : v;

const POOLS = [
  { name: "Etherfuse",    id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI" },
  { name: "Fixed v2",     id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD" },
  { name: "YieldBlox v2", id: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS" },
];

async function getPoolConfigEntry(poolId: string): Promise<void> {
  const contractIdBytes = StrKey.decodeContract(poolId);
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractAddr = xdr.ScAddress.scAddressTypeContract(contractHash);

  // Key is Symbol("PoolConfig")
  const keyScVal = xdr.ScVal.scvSymbol("PoolConfig");
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddr,
      key: keyScVal,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  try {
    const result = await server.getLedgerEntries(ledgerKey);
    if (!result.entries?.length) {
      console.log("  No entry found for PoolConfig");
      return;
    }
    const dataEntry = result.entries[0].val.contractData().val();
    const native = scValToNative(dataEntry);
    console.log("  PoolConfig:", JSON.stringify(native, bigIntReplacer, 2));
  } catch (e) {
    console.log("  Error:", e);
  }
}

async function main() {
  for (const pool of POOLS) {
    console.log(`\n=== ${pool.name} (${pool.id}) ===`);
    await getPoolConfigEntry(pool.id);
  }
}

main().catch(console.error);
