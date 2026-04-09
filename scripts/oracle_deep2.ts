import { StrKey, rpc as SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";

const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
const server = new SorobanRpc.Server("https://rpc.lightsail.network/");

async function main() {
  const contractIdBytes = StrKey.decodeContract(ORACLE_ID);
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractAddr = xdr.ScAddress.scAddressTypeContract(contractHash);
  
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddr,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  const result = await server.getLedgerEntries(ledgerKey);
  if (!result.entries?.length) { console.log("No entry"); return; }

  // Get the raw XDR and parse it properly
  const rawXdr = result.entries[0].val.toXDR("base64");
  const parsed = xdr.LedgerEntryData.fromXDR(rawXdr, "base64");
  const cd = parsed.contractData();
  const val = cd.val();
  
  console.log("Val type:", val.switch().name);
  
  if (val.switch().name === "scvContractInstance") {
    const inst = val.contractInstance();
    const exec = inst.executable();
    console.log("Executable type:", exec.switch().name);
    
    if (exec.switch().name === "contractExecutableWasm") {
      const wasmHash = exec.wasmHash().toString("hex");
      console.log("WASM hash:", wasmHash);
    }
    
    const st = inst.storage();
    if (st && st.length > 0) {
      console.log(`\nInstance storage (${st.length} entries):`);
      for (const item of st) {
        try {
          const k = scValToNative(item.key());
          const v = scValToNative(item.val());
          console.log(`  [${JSON.stringify(k)}]:`, JSON.stringify(v, (_, v) => typeof v === "bigint" ? v.toString() : v));
        } catch(e) {
          console.log(`  (parse error for entry)`);
        }
      }
    } else {
      console.log("No instance storage");
    }
  }

  // Check temporary storage for recent prices
  console.log("\n=== Checking temporary storage ===");
  for (const keyName of ["Prices", "Admin", "Oracle"]) {
    try {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddr,
          key: xdr.ScVal.scvSymbol(keyName),
          durability: xdr.ContractDataDurability.temporary(),
        })
      );
      const r = await server.getLedgerEntries(key);
      if (r.entries?.length) {
        const raw = r.entries[0].val.toXDR("base64");
        const p = xdr.LedgerEntryData.fromXDR(raw, "base64");
        const v = scValToNative(p.contractData().val());
        console.log(`Temporary[${keyName}]:`, JSON.stringify(v, (_, v) => typeof v === "bigint" ? v.toString() : v));
      }
    } catch {}
  }
  
  // Check persistent storage
  console.log("\n=== Checking persistent storage ===");
  for (const keyName of ["Prices", "Admin", "Oracle", "Source", "Config", "Reflector", "Underlying"]) {
    try {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddr,
          key: xdr.ScVal.scvSymbol(keyName),
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      const r = await server.getLedgerEntries(key);
      if (r.entries?.length) {
        const raw = r.entries[0].val.toXDR("base64");
        const p = xdr.LedgerEntryData.fromXDR(raw, "base64");
        const v = scValToNative(p.contractData().val());
        console.log(`Persistent[${keyName}]:`, JSON.stringify(v, (_, v) => typeof v === "bigint" ? v.toString() : v));
      }
    } catch {}
  }
}

main().catch(console.error);
