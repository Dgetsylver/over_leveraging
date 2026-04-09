/**
 * Read pool config from contract instance storage.
 */
import {
  StrKey,
  rpc as SorobanRpc,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://rpc.lightsail.network/";
const server  = new SorobanRpc.Server(RPC_URL);
const bigIntReplacer = (_: string, v: any) => typeof v === "bigint" ? v.toString() : v;

const POOLS = [
  { name: "Etherfuse",    id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI" },
  { name: "Fixed v2",     id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD" },
  { name: "YieldBlox v2", id: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS" },
];

async function readInstanceStorage(poolId: string): Promise<void> {
  const contractIdBytes = StrKey.decodeContract(poolId);
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractAddr = xdr.ScAddress.scAddressTypeContract(contractHash);

  // Read the contract instance entry which contains instance storage
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddr,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  try {
    const result = await server.getLedgerEntries(ledgerKey);
    if (!result.entries?.length) {
      console.log("  No instance entry found");
      return;
    }
    const entry = result.entries[0];
    const val = entry.val;
    // The val is an XDR LedgerEntryData — try to parse
    const raw = (val as any).toXDR("base64");
    // Parse via contractData
    const ledgerEntryData = xdr.LedgerEntryData.fromXDR(raw, "base64");
    const contractData = ledgerEntryData.contractData();
    const storedVal = contractData.val();
    if (storedVal.switch().name === "scvContractInstance") {
      const storage = storedVal.contractInstance().storage();
      if (storage) {
        console.log("  Instance storage entries:");
        for (const item of storage) {
          const k = scValToNative(item.key());
          const v = scValToNative(item.val());
          console.log(`    [${JSON.stringify(k)}]:`, JSON.stringify(v, bigIntReplacer));
        }
      } else {
        console.log("  Instance storage is empty/null");
      }
    } else {
      console.log("  Value type:", storedVal.switch().name);
    }
  } catch (e) {
    console.log("  Error:", (e as any).message?.slice(0, 200) ?? e);
  }
}

async function main() {
  for (const pool of POOLS) {
    console.log(`\n=== ${pool.name} (${pool.id}) ===`);
    await readInstanceStorage(pool.id);
  }
}

main().catch(console.error);
