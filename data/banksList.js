export const nigeriaBanks = [
  // Commercial Banks
  { name: "Access Bank", code: "044" },
  { name: "Citibank Nigeria", code: "023" },
  { name: "Ecobank Nigeria", code: "050" },
  { name: "Fidelity Bank", code: "070" },
  { name: "First Bank of Nigeria", code: "011" },
  { name: "First City Monument Bank", code: "214" },
  { name: "Globus Bank", code: "103" },
  { name: "Guaranty Trust Bank", code: "058" },
  { name: "Heritage Bank", code: "030" },
  { name: "Jaiz Bank", code: "301" },
  { name: "Keystone Bank", code: "082" },
  { name: "Polaris Bank", code: "076" },
  { name: "Providus Bank", code: "101" },
  { name: "Stanbic IBTC Bank", code: "221" },
  { name: "Standard Chartered Bank", code: "068" },
  { name: "Sterling Bank", code: "232" },
  { name: "SunTrust Bank", code: "100" },
  { name: "TAJ Bank", code: "302" },
  { name: "Titan Trust Bank", code: "102" },
  { name: "Union Bank of Nigeria", code: "032" },
  { name: "United Bank for Africa", code: "033" },
  { name: "Unity Bank", code: "215" },
  { name: "Wema Bank", code: "035" },
  { name: "Zenith Bank", code: "057" },
  { name: "Premium Trust Bank", code: "105" },
  { name: "Optimus Bank", code: "107" },
  { name: "Parallex Bank", code: "526" },
  // Digital Banks & Payment Service Banks
  { name: "9Payment Service Bank", code: "120001" },
  { name: "Carbon", code: "565" },
  { name: "ALAT by Wema", code: "035A" },
  { name: "Eyowo", code: "50126" },
  { name: "Kuda Bank", code: "90267" },
  { name: "OPay", code: "999992" },
  { name: "PalmPay", code: "999" },
  { name: "Rubies Microfinance Bank", code: "125" },
  { name: "VFD Microfinance Bank", code: "566" },
  { name: "Moniepoint Microfinance Bank", code: "50515" },
  { name: "HopePSB", code: "120002" },
  { name: "Sparkle Microfinance Bank", code: "51310" },
  { name: "Flutterwave Technology Solutions", code: "110013" },
  // Microfinance Banks
  { name: "Abbey Mortgage Bank", code: "801" },
  { name: "Accion Microfinance Bank", code: "602" },
  { name: "Ahmadu Bello University Microfinance Bank", code: "50036" },
  { name: "CEMCS Microfinance Bank", code: "50823" },
  { name: "Ekondo Microfinance Bank", code: "562" },
  { name: "Fidelity IMPAC Microfinance Bank", code: "50869" },
  { name: "Firmus MFB", code: "51314" },
  { name: "First Option Microfinance Bank", code: "50476" },
  { name: "Goodnews Microfinance Bank", code: "50739" },
  { name: "Greenwich Merchant Bank", code: "50439" },
  { name: "Hackman Microfinance Bank", code: "51251" },
  { name: "Hasal Microfinance Bank", code: "50383" },
  { name: "Ibile Microfinance Bank", code: "51244" },
  { name: "Infinity Microfinance Bank", code: "50457" },
  { name: "Lagos Building Investment Company", code: "90052" },
  { name: "Links Microfinance Bank", code: "50549" },
  { name: "Lovonus Microfinance Bank", code: "50923" },
  { name: "Mayfresh Mortgage Bank", code: "50563" },
  { name: "Mint-Finex MFB", code: "50613" },
  { name: "NPF Microfinance Bank", code: "070001" },
  { name: "Paga", code: "100002" },
  { name: "Page Financials", code: "560" },
  { name: "Parkway-ReadyCash", code: "311" },
  { name: "PayAttitude", code: "110001" },
  { name: "Petra Microfinance Bank", code: "50746" },
  { name: "Platinum Mortgage Bank", code: "268" },
  { name: "Quick Funds MFB", code: "51293" },
  { name: "Rephidim Microfinance Bank", code: "50994" },
  { name: "SafeTrust", code: "403" },
  { name: "TCF Microfinance Bank", code: "51211" },
  { name: "TeasyMobile", code: "100010" },
  { name: "Trident Microfinance Bank", code: "50864" },
  { name: "Trustbond Mortgage Bank", code: "523" },
  { name: "Unical Microfinance Bank", code: "50871" },
  { name: "Zinternet Nigera Limited", code: "100025" },
  { name: "ChamsMobile", code: "303" },
  { name: "Hedonmark", code: "121" },
  { name: "eTranzact", code: "306" },
  { name: "Stanbic Mobile", code: "304" },
  { name: "Fortis Microfinance Bank", code: "501" },
  { name: "FBN Mortgages", code: "413" },
  { name: "AG Mortgage Bank", code: "40001" },
  { name: "FSDH Merchant Bank", code: "400001" },
  { name: "Mkobo Microfinance Bank", code: "50726" },
  { name: "Rand Merchant Bank", code: "502" },
  { name: "Coronation Merchant Bank", code: "559" },
  { name: "FFS Microfinance Bank", code: "51315" },
  { name: "Seed Capital Microfinance Bank", code: "609" },
  { name: "Empire Trust Microfinance Bank", code: "50755" },
  { name: "Stanford Microfinance Bank", code: "50992" },
  { name: "Flourish Microfinance Bank", code: "50315" }
];

// Function to get a bank name from code
export const getBankNameFromCode = (code) => {
  console.log("getBankNameFromCode called with code:", code);
  const bankByCode = nigeriaBanks.find(bank => bank.code.toString() === code.toString());
  if (bankByCode) {
    console.log("Found bank in nigeriaBanks:", bankByCode.name);
    return bankByCode.name;
  }

  if (typeof window === "undefined") {
    const apiBanks = cache ? cache.get("banks") || [] : [];
    console.log("Server-side: apiBanks from cache:", apiBanks);
    const apiBankMatch = apiBanks.find(bank => bank.code.toString() === code.toString());
    if (apiBankMatch) {
      console.log("Found bank in server cache:", apiBankMatch.name);
      return apiBankMatch.name;
    }
  } else {
    const apiBanks = JSON.parse(localStorage.getItem('apiBanks') || '[]');
    console.log("Client-side: apiBanks from localStorage:", apiBanks);
    const apiBankMatch = apiBanks.find(bank => bank.code.toString() === code.toString());
    if (apiBankMatch) {
      console.log("Found bank in localStorage:", apiBankMatch.name);
      return apiBankMatch.name;
    }
  }

  console.log("Bank not found, returning 'Unknown Bank'");
  return "Unknown Bank";
};

// Function to get a bank code from name
export const getBankCodeFromName = (name) => {
  const bank = nigeriaBanks.find(bank => bank.name.toLowerCase() === name.toLowerCase());
  return bank ? bank.code : null;
};

// Search function to find banks by partial name
export const searchBanksByName = (partialName) => {
  if (!partialName) return [];
  const searchTerm = partialName.toLowerCase();
  return nigeriaBanks.filter(bank =>
    bank.name.toLowerCase().includes(searchTerm)
  );
};

// Validate nigeriaBanks on module load
if (!Array.isArray(nigeriaBanks)) {
  console.error("nigeriaBanks is not an array:", nigeriaBanks);
  throw new Error("Invalid bank list configuration in banksList.js");
}

export default nigeriaBanks;