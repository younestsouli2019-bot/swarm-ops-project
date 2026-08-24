/**
 * Moroccan Supplier Registry
 *
 * Verified Moroccan suppliers for mandatory local sourcing.
 * Each supplier has a URL, category, and verification status.
 */

export interface MoroccanSupplier {
  id: string;
  name: string;
  url: string;
  category: "food" | "electronics" | "health" | "home" | "fashion" | "wholesale" | "refurbished";
  verified: boolean;
  payment_methods: string[];
  avg_delivery_days: number;
  notes?: string;
}

export const MOROCCAN_SUPPLIERS: MoroccanSupplier[] = [
  {
    id: "superfood-ma",
    name: "Superfood.ma",
    url: "https://superfood.ma",
    category: "food",
    verified: true,
    payment_methods: ["cod", "ccp", "bank_transfer"],
    avg_delivery_days: 3,
    notes: "Premium Moroccan supplements and health packs"
  },
  {
    id: "jumia-ma",
    name: "Jumia Maroc",
    url: "https://www.jumia.ma",
    category: "electronics",
    verified: true,
    payment_methods: ["cod", "credit_card", "wallet"],
    avg_delivery_days: 5,
    notes: "Largest Moroccan e-commerce platform"
  },
  {
    id: "wholesale-ma",
    name: "Wholesale Supplier (JemlaMaroc)",
    url: "https://www.jumia.ma",
    category: "wholesale",
    verified: true,
    payment_methods: ["cod", "bank_transfer"],
    avg_delivery_days: 7,
    notes: "Bulk electronics accessories via Jumia"
  },
  {
    id: "samsung-ma",
    name: "Samsung Maroc",
    url: "https://www.samsung.com/ma/",
    category: "electronics",
    verified: true,
    payment_methods: ["credit_card", "bank_transfer"],
    avg_delivery_days: 7,
    notes: "Official Samsung Morocco distributor"
  },
  {
    id: "avito-ma",
    name: "Avito Maroc (Refurbished)",
    url: "https://www.avito.ma",
    category: "refurbished",
    verified: true,
    payment_methods: ["cod", "bank_transfer"],
    avg_delivery_days: 3,
    notes: "Moroccan classifieds for refurbished electronics"
  },
  {
    id: "toko-ma",
    name: "Toko.ma",
    url: "https://www.toko.ma",
    category: "electronics",
    verified: true,
    payment_methods: ["cod", "credit_card"],
    avg_delivery_days: 5,
    notes: "Moroccan electronics retailer"
  },
  {
    id: "amed-ma",
    name: "Amed.ma",
    url: "https://www.amed.ma",
    category: "health",
    verified: true,
    payment_methods: ["cod", "credit_card"],
    avg_delivery_days: 4,
    notes: "Moroccan pharmacy and health products"
  },
  {
    id: "mirka-ma",
    name: "Mirka.ma",
    url: "https://www.mirka.ma",
    category: "food",
    verified: true,
    payment_methods: ["cod", "ccp"],
    avg_delivery_days: 2,
    notes: "Moroccan coffee and specialty beverages"
  },
  {
    id: "parfum-ma",
    name: "ParfumMaroc",
    url: "https://www.parfummaroc.com",
    category: "fashion",
    verified: true,
    payment_methods: ["cod", "credit_card"],
    avg_delivery_days: 3,
    notes: "Moroccan perfume retailer"
  },
  {
    id: "bouznika-marche",
    name: "Marché Local Bouznika",
    url: "local",
    category: "food",
    verified: true,
    payment_methods: ["cash"],
    avg_delivery_days: 1,
    notes: "Local fresh market in Bouznika"
  },
  {
    id: "cafe-gold",
    name: "Cafe Gold",
    url: "local",
    category: "food",
    verified: true,
    payment_methods: ["cash", "ccp"],
    avg_delivery_days: 1,
    notes: "Local cafe supplies"
  },
  {
    id: "vasoun-jumia",
    name: "VASOUN (via Jumia)",
    url: "https://www.jumia.ma",
    category: "electronics",
    verified: true,
    payment_methods: ["cod", "credit_card"],
    avg_delivery_days: 5,
    notes: "Tablets and accessories via Jumia"
  },
  {
    id: "brooklyn-smoke",
    name: "Brooklyn Smoke Shop (Import)",
    url: "import",
    category: "fashion",
    verified: false,
    payment_methods: ["bank_transfer"],
    avg_delivery_days: 14,
    notes: "Imported cigarillos - requires customs clearance"
  },
  {
    id: "tagin3d",
    name: "TAGin3D",
    url: "local",
    category: "home",
    verified: true,
    payment_methods: ["cod", "ccp"],
    avg_delivery_days: 3,
    notes: "3D printing supplies"
  }
];

/**
 * Find the best Moroccan supplier for a given item
 */
export function findSupplierForItem(itemName: string, currentSupplier: string): MoroccanSupplier | null {
  const lowerName = itemName.toLowerCase();
  const lowerCurrent = currentSupplier.toLowerCase();

  // Match by name
  for (const s of MOROCCAN_SUPPLIERS) {
    if (lowerCurrent.includes(s.id.replace("-ma", "").replace("-", " ")) || 
        lowerCurrent.includes(s.name.toLowerCase().split(" ")[0])) {
      return s;
    }
  }

  // Match by category keywords
  if (lowerName.includes("parfum") || lowerName.includes("cigarillos")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "parfum-ma") || null;
  }
  if (lowerName.includes("cafe") || lowerName.includes("cigarillos")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "cafe-gold") || null;
  }
  if (lowerName.includes("supplement") || lowerName.includes("pack diabetes") || lowerName.includes("nitric oxide")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "superfood-ma") || null;
  }
  if (lowerName.includes("camera") || lowerName.includes("dvr") || lowerName.includes("dahua")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "jumia-ma") || null;
  }
  if (lowerName.includes("wholesale") || lowerName.includes("bluetooth") || lowerName.includes("rfid") ||
      lowerName.includes("hygrometer") || lowerName.includes("earphone") || lowerName.includes("hand warmer") ||
      lowerName.includes("tripod") || lowerName.includes("power strip") || lowerName.includes("cable") ||
      lowerName.includes("timer") || lowerName.includes("car kit") || lowerName.includes("gloves") ||
      lowerName.includes("fm transmitter") || lowerName.includes("organizer") || lowerName.includes("voice recorder") ||
      lowerName.includes("microphone") || lowerName.includes("case")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "wholesale-ma") || null;
  }
  if (lowerName.includes("samsung") || lowerName.includes("barre de son")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "samsung-ma") || null;
  }
  if (lowerName.includes("refurbished") || lowerName.includes("dell precision")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "avito-ma") || null;
  }
  if (lowerName.includes("tablette") || lowerName.includes("vasoun")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "vasoun-jumia") || null;
  }
  if (lowerName.includes("dentifrice") || lowerName.includes("opalescence")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "amed-ma") || null;
  }
  if (lowerName.includes("cafe pur") || lowerName.includes("bali")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "mirka-ma") || null;
  }
  if (lowerName.includes("légumes") || lowerName.includes("poisson") || lowerName.includes("pack legumes")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "bouznika-marche") || null;
  }
  if (lowerName.includes("kit pause") || lowerName.includes("elexia") || lowerName.includes("mini-bar")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "cafe-gold") || null;
  }
  if (lowerName.includes("3d") || lowerName.includes("spatule")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "tagin3d") || null;
  }
  if (lowerName.includes("nettoyeur") || lowerName.includes("brosse electrique") || lowerName.includes("camera tableau")) {
    return MOROCCAN_SUPPLIERS.find(s => s.id === "jumia-ma") || null;
  }

  // Default to Jumia for anything else
  return MOROCCAN_SUPPLIERS.find(s => s.id === "jumia-ma") || null;
}
