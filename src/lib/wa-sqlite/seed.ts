/**
 * Retail demo dataset seeder. Deterministic for a given seed: same RNG,
 * same sampling, same row counts and IDs from one run to the next.
 *
 * Hidden-pattern documentation lives in `src/lib/data-sources/about/retail.ts`
 * — that file is what users see in the Demo Dialog; keep it authoritative if
 * you change the bias weights below.
 */

import * as SQLite from 'wa-sqlite';

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

export interface WaSeedOptions {
    seed?: number;
    products?: number;
    customers?: number;
    orders?: number;
    /** Drop existing seed tables and re-seed. */
    force?: boolean;
}

export interface WaSeedSummary {
    seeded: boolean;
    tables: Record<string, number>;
    elapsedMs: number;
}

const DEFAULTS = {
    seed: 0xc0ffee,
    products: 2000,
    customers: 10_000,
    orders: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Curated catalog data
// ---------------------------------------------------------------------------

type BrandSpec = { brand: string; models: readonly string[]; defaultCategory: string };

const BRANDS: readonly BrandSpec[] = [
    { brand: 'Nike',        models: ['Pegasus', 'Air Max', 'Air Force 1', 'React Infinity', 'Vaporfly', 'Blazer'], defaultCategory: 'sneakers' },
    { brand: 'Adidas',      models: ['Ultraboost', 'NMD', 'Stan Smith', 'Samba', 'Gazelle', 'Adizero'],           defaultCategory: 'sneakers' },
    { brand: 'Puma',        models: ['Suede', 'RS-X', 'Cell Endura', 'Cali', 'Future Rider'],                     defaultCategory: 'sneakers' },
    { brand: 'New Balance', models: ['990', '574', '550', '327', '1080'],                                          defaultCategory: 'sneakers' },
    { brand: 'Asics',       models: ['Gel-Kayano', 'Gel-Nimbus', 'Gel-Lyte', 'Novablast'],                         defaultCategory: 'running'  },
    { brand: 'Brooks',      models: ['Ghost', 'Glycerin', 'Adrenaline', 'Levitate'],                               defaultCategory: 'running'  },
    { brand: 'Hoka',        models: ['Clifton', 'Bondi', 'Mach', 'Speedgoat'],                                     defaultCategory: 'running'  },
    { brand: 'Salomon',     models: ['Speedcross', 'X Ultra', 'XT-6'],                                              defaultCategory: 'hiking'   },
    { brand: 'Reebok',      models: ['Classic Leather', 'Club C', 'Nano X', 'Zig Kinetica'],                       defaultCategory: 'sneakers' },
    { brand: 'Vans',        models: ['Old Skool', 'Authentic', 'Era', 'Sk8-Hi'],                                   defaultCategory: 'casual'   },
    { brand: 'Converse',    models: ['Chuck Taylor', 'Chuck 70', 'Run Star'],                                       defaultCategory: 'casual'   },
    { brand: 'Skechers',    models: ['GO Walk', "D'Lites", 'Arch Fit'],                                             defaultCategory: 'casual'   },
    { brand: 'Timberland',  models: ['6-inch Premium', 'Killington', 'Field Boot'],                                 defaultCategory: 'boots'    },
    { brand: 'Dr. Martens', models: ['1460', '1461', 'Jadon'],                                                      defaultCategory: 'boots'    },
    { brand: 'On',          models: ['Cloud', 'Cloudmonster', 'Cloudswift'],                                        defaultCategory: 'running'  },
    { brand: 'Birkenstock', models: ['Arizona', 'Boston', 'Madrid'],                                                defaultCategory: 'sandals'  },
    { brand: 'Allbirds',    models: ['Wool Runner', 'Tree Dasher', 'Tree Runner'],                                  defaultCategory: 'sneakers' },
];

const CATEGORIES = ['running', 'sneakers', 'casual', 'hiking', 'boots', 'sandals'] as const;
const GENDERS = ['men', 'women', 'unisex', 'kids'] as const;
const COLORS = ['Black','White','Grey','Navy','Red','Blue','Green','Pink','Beige','Brown','Olive','Charcoal','Cream','Yellow','Orange'] as const;
const MATERIALS = ['Mesh','Leather','Suede','Canvas','Synthetic','Knit','Nubuck','Recycled'] as const;
const SHOE_SIZES = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13] as const;

const WAREHOUSES = [
    { code: 'NYC01', name: 'New York Distribution Center', city: 'New York',     country: 'USA' },
    { code: 'LAX01', name: 'Los Angeles Fulfillment',      city: 'Los Angeles',  country: 'USA' },
    { code: 'CHI01', name: 'Chicago Hub',                  city: 'Chicago',      country: 'USA' },
    { code: 'ATL01', name: 'Atlanta South Hub',            city: 'Atlanta',      country: 'USA' },
    { code: 'DAL01', name: 'Dallas Cross-dock',            city: 'Dallas',       country: 'USA' },
    { code: 'YYZ01', name: 'Toronto Logistics',            city: 'Toronto',      country: 'Canada' },
    { code: 'YVR01', name: 'Vancouver West Coast',         city: 'Vancouver',    country: 'Canada' },
    { code: 'LHR01', name: 'London Heathrow Depot',        city: 'London',       country: 'UK' },
    { code: 'FRA01', name: 'Frankfurt Central',            city: 'Frankfurt',    country: 'Germany' },
    { code: 'CDG01', name: 'Paris Fulfillment',            city: 'Paris',        country: 'France' },
    { code: 'AMS01', name: 'Amsterdam Schiphol Depot',     city: 'Amsterdam',    country: 'Netherlands' },
    { code: 'BCN01', name: 'Barcelona Mediterranean',      city: 'Barcelona',    country: 'Spain' },
    { code: 'MIL01', name: 'Milan Distribution',           city: 'Milan',        country: 'Italy' },
    { code: 'NRT01', name: 'Tokyo Narita Hub',             city: 'Tokyo',        country: 'Japan' },
    { code: 'SYD01', name: 'Sydney Fulfillment',           city: 'Sydney',       country: 'Australia' },
    { code: 'GRU01', name: 'São Paulo South America',      city: 'São Paulo',    country: 'Brazil' },
    { code: 'MEX01', name: 'Mexico City Central',          city: 'Mexico City',  country: 'Mexico' },
];

const FIRST_NAMES = [
    'Olivia','Liam','Emma','Noah','Ava','Elijah','Sophia','James','Isabella','William',
    'Mia','Lucas','Charlotte','Mason','Amelia','Logan','Harper','Ethan','Evelyn','Aiden',
    'Abigail','Sebastian','Ella','Carter','Ellie','Henry','Avery','Owen','Scarlett','Daniel',
    'Grace','Jackson','Chloe','Wyatt','Victoria','David','Riley','Joseph','Aria','Samuel',
    'Lily','Levi','Aubrey','Jack','Zoey','Andrew','Mila','Anthony','Hannah','Joshua',
    'Layla','Christopher','Brooklyn','Dylan','Penelope','Asher','Camila','John','Stella','Caleb',
    'Aaliyah','Isaiah','Maya','Adam','Sara','Eli','Naomi','Hudson','Audrey','Jeremiah',
    'Skylar','Jayden','Genesis','Connor','Ariana','Lincoln','Eleanor','Greyson','Hazel','Robert',
    'Ruby','Jonathan','Eva','Cameron','Nora','Ezekiel','Madeline','Roman','Sadie','Easton',
    'Cora','Theodore','Aurora','Aaron','Madison','Jaxon','Quinn','Nathan','Paisley','Maverick',
    'Diego','Mateo','Ivan','Pablo','Camila','Jose','Lucia','Sofia','Daniela','Manuel',
    'Hiroshi','Yuki','Aiko','Takeshi','Sakura','Haruto','Yui','Ren','Aoi','Sora',
    'Liam','Niamh','Cian','Aoife','Eoin','Saoirse','Conor','Sinead','Padraig','Roisin',
];

const LAST_NAMES = [
    'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
    'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
    'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
    'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores',
    'Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts',
    'Gomez','Phillips','Evans','Turner','Diaz','Parker','Cruz','Edwards','Collins','Reyes',
    'Stewart','Morris','Morales','Murphy','Cook','Rogers','Gutierrez','Ortiz','Morgan','Cooper',
    'Peterson','Bailey','Reed','Kelly','Howard','Ramos','Kim','Cox','Ward','Richardson',
    'Watson','Brooks','Chavez','Wood','James','Bennett','Gray','Mendoza','Ruiz','Hughes',
    'Price','Alvarez','Castillo','Sanders','Patel','Myers','Long','Ross','Foster','Jimenez',
    'O\'Connor','Doyle','Ryan','McCarthy','Murphy','Walsh','Byrne','Kelly',
    'Yamamoto','Sato','Suzuki','Takahashi','Tanaka','Watanabe','Ito','Yamada',
    'Schmidt','Müller','Schneider','Fischer','Weber','Meyer','Wagner','Becker',
    'Dubois','Moreau','Laurent','Simon','Michel','Lefebvre','Leroy','Roux',
    'Rossi','Russo','Bianchi','Romano','Colombo','Ricci','Marino','Greco',
];

const COUNTRIES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['USA',       ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego','Dallas','San Jose','Austin','Jacksonville','Fort Worth','Columbus','Seattle','Denver','Boston','Nashville','Portland','Las Vegas']],
    ['Canada',    ['Toronto','Vancouver','Montreal','Calgary','Ottawa','Edmonton','Winnipeg','Quebec City','Halifax','Victoria']],
    ['UK',        ['London','Manchester','Birmingham','Leeds','Glasgow','Edinburgh','Bristol','Liverpool','Nottingham','Sheffield']],
    ['Germany',   ['Berlin','Munich','Hamburg','Cologne','Frankfurt','Stuttgart','Düsseldorf','Leipzig','Dortmund','Bremen']],
    ['France',    ['Paris','Marseille','Lyon','Toulouse','Nice','Nantes','Strasbourg','Montpellier','Bordeaux','Lille']],
    ['Spain',     ['Madrid','Barcelona','Valencia','Seville','Zaragoza','Málaga','Murcia','Palma','Bilbao','Granada']],
    ['Italy',     ['Rome','Milan','Naples','Turin','Palermo','Genoa','Bologna','Florence','Verona','Venice']],
    ['Japan',     ['Tokyo','Yokohama','Osaka','Nagoya','Sapporo','Fukuoka','Kobe','Kyoto','Kawasaki','Saitama']],
    ['Australia', ['Sydney','Melbourne','Brisbane','Perth','Adelaide','Canberra','Hobart','Darwin','Newcastle','Wollongong']],
    ['Brazil',    ['São Paulo','Rio de Janeiro','Brasília','Salvador','Fortaleza','Belo Horizonte','Manaus','Curitiba','Recife','Porto Alegre']],
    ['Mexico',    ['Mexico City','Guadalajara','Monterrey','Puebla','Tijuana','León','Juárez','Zapopan','Mérida','Cancún']],
];

const CHANNELS = ['web', 'mobile', 'in_store', 'partner', 'marketplace'] as const;

const ORDER_STATUSES = ['delivered', 'shipped', 'paid', 'cancelled', 'pending', 'refunded'] as const;
const STATUS_WEIGHTS_DEFAULT = [0.62, 0.15, 0.08, 0.07, 0.05, 0.03] as const;
const STATUS_WEIGHTS_PARTNER = [0.46, 0.13, 0.07, 0.21, 0.05, 0.08] as const;

const LOYALTY_TIERS = ['bronze', 'silver', 'gold', 'platinum'] as const;
const LOYALTY_ASSIGNMENT_WEIGHTS = [0.65, 0.22, 0.10, 0.03] as const;
const LOYALTY_PICK_WEIGHT: Record<string, number> = {
    bronze: 1.0, silver: 1.5, gold: 2.5, platinum: 5.0,
};

const LINE_COUNTS = [1, 2, 3, 4] as const;
const LINE_COUNT_WEIGHTS = [0.55, 0.28, 0.12, 0.05] as const;

const QUANTITIES = [1, 2, 3] as const;
const QUANTITY_WEIGHTS = [0.78, 0.18, 0.04] as const;

const RETURN_REASONS = ['wrong_size','defective','did_not_like','late_delivery','color_mismatch','comfort','other'] as const;
const RETURN_REASON_WEIGHTS_BOOTS = [0.55, 0.10, 0.10, 0.05, 0.10, 0.05, 0.05] as const;

const CLAIM_CATEGORIES = ['warranty','quality','shipping_damage','sizing_issue','customer_service'] as const;
const CLAIM_CATEGORY_WEIGHTS_SKECHERS = [0.45, 0.40, 0.05, 0.05, 0.05] as const;
const CLAIM_SEVERITIES = ['low','medium','high'] as const;
const CLAIM_SEVERITY_WEIGHTS_DEFAULT = [0.55, 0.32, 0.13] as const;
const CLAIM_SEVERITY_WEIGHTS_SKECHERS = [0.20, 0.45, 0.35] as const;
const CLAIM_STATUSES = ['open','in_review','resolved','rejected'] as const;
const CLAIM_STATUS_WEIGHTS = [0.10, 0.18, 0.60, 0.12] as const;

const CLAIM_TEMPLATES: Record<string, readonly string[]> = {
    warranty: [
        'Sole separated from upper after three weeks of normal wear.',
        'Insole flattened completely within the first month of use.',
        'Outsole tread wore down to the midsole on light city walking.',
        'Eyelets pulled out of the upper during normal lacing.',
        'Heel collar collapsed after being worn fewer than ten times.',
        'Lace aglet broke on day one; lace frays from there.',
        'Tongue padding migrated and bunched inside the shoe.',
        'Midsole compressed unevenly making the shoe rock side to side.',
        'Insole gel pack ruptured leaving the shoe unusable.',
        'Toe box collapsed and would not regain shape after wear.',
    ],
    quality: [
        'Stitching unraveling along the toe cap.',
        'Glue residue visible on the upper.',
        'Material started pilling after a single day of wear.',
        'Loose threads visible across both shoes out of the box.',
        'Uneven dye lot — pair shipped in two visibly different shades.',
        'Stitching gauge inconsistent along the side panels.',
        'Adhesive bleed-through staining the leather.',
        'Lining detached at the heel after light use.',
        'Branding decal peeled off within the first week.',
    ],
    shipping_damage: [
        'Box arrived crushed; one shoe creased.',
        'Inner box opened; shoes scuffed.',
        'Package soaked from rain transit.',
        'Carrier label punctured the lid, damaging the toe.',
        'Outer box re-sealed with tape — contents not the items ordered.',
        'Shoebox missing tissue paper, both shoes scratched.',
        'Both shoes had transit creasing across the vamp.',
        'Package arrived open with one shoe missing.',
        'Heavy item stacked on top — heel counter dented.',
        'Box arrived clearly opened and inspected; missing original tags.',
    ],
    sizing_issue: [
        'Marked size runs at least one size small.',
        'Width felt narrower than expected for the listed size.',
        'Two shoes in the pair fit differently.',
        'Length matches the chart but the shoes are noticeably tight at the toe.',
        'Heel cup proportionally too wide for the marked size.',
        'Listed half-size feels closer to a full size up.',
        'Arch placement sits forward of where this size usually has it.',
        'Insole removed but the shoe still fits a full size small.',
        'Wide-width version felt narrower than the regular-width pair we own.',
        'Marked size is correct for one foot, off for the other.',
    ],
    customer_service: [
        'Replacement request unanswered for two weeks.',
        'Refund processed for the wrong amount.',
        'Agent provided incorrect return label.',
        'Chat agent closed the ticket without resolution.',
        'Email auto-replies looping without a human response.',
        'Phone hold time exceeded forty minutes on three attempts.',
        'Promised callback never arrived.',
        'Return tracking updated as received but refund not issued.',
        'Support advised a policy that contradicted the published terms.',
        'Multiple agents gave conflicting information on the same case.',
    ],
};

// ---------------------------------------------------------------------------
// Bias weights (the "hidden facts" in numeric form)
// ---------------------------------------------------------------------------

const BRAND_POPULARITY: Record<string, number> = {
    Nike: 0.26, Adidas: 0.18, 'New Balance': 0.09, Asics: 0.07, Puma: 0.06,
    Vans: 0.06, Converse: 0.05, Brooks: 0.04, Hoka: 0.04, Reebok: 0.03,
    'Dr. Martens': 0.03, Skechers: 0.03, Timberland: 0.025, Salomon: 0.02,
    On: 0.02, Birkenstock: 0.015, Allbirds: 0.015,
};

const COLOR_POPULARITY: Record<string, number> = {
    Black: 4.0, White: 4.0, Grey: 2.5, Navy: 2.0, Brown: 1.5, Red: 1.5,
    Blue: 1.5, Charcoal: 1.2, Pink: 1.2, Beige: 1.0, Green: 1.0, Cream: 1.0,
    Olive: 0.6, Yellow: 0.4, Orange: 0.4,
};

const SEASONALITY: Record<string, readonly number[]> = {
    running:  [2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 1.0, 1.0, 1.0],
    sneakers: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.2, 1.0, 1.0, 1.1],
    casual:   [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    hiking:   [0.8, 0.7, 0.9, 1.1, 1.2, 1.0, 0.9, 0.9, 1.2, 1.5, 2.0, 2.0],
    boots:    [3.0, 2.0, 1.2, 0.6, 0.4, 0.3, 0.3, 0.3, 0.8, 1.6, 2.6, 3.2],
    sandals:  [0.4, 0.4, 0.6, 1.5, 2.5, 3.2, 3.5, 3.0, 1.5, 0.6, 0.4, 0.4],
};

const CHANNEL_WEIGHTS_BY_COUNTRY: Record<string, readonly number[]> = {
    USA:       [0.40, 0.28, 0.22, 0.05, 0.05],
    Canada:    [0.50, 0.30, 0.10, 0.05, 0.05],
    UK:        [0.50, 0.30, 0.10, 0.05, 0.05],
    Germany:   [0.60, 0.22, 0.10, 0.04, 0.04],
    France:    [0.55, 0.25, 0.10, 0.05, 0.05],
    Spain:     [0.45, 0.30, 0.10, 0.07, 0.08],
    Italy:     [0.45, 0.30, 0.10, 0.07, 0.08],
    Japan:     [0.20, 0.60, 0.10, 0.05, 0.05],
    Australia: [0.45, 0.30, 0.10, 0.07, 0.08],
    Brazil:    [0.30, 0.25, 0.10, 0.10, 0.25],
    Mexico:    [0.30, 0.25, 0.10, 0.10, 0.25],
};
const CHANNEL_WEIGHTS_FALLBACK = [0.45, 0.30, 0.10, 0.08, 0.07] as const;

const RETURN_RATE_BY_CATEGORY: Record<string, number> = {
    boots: 0.12, hiking: 0.08, sneakers: 0.07, casual: 0.05, running: 0.05, sandals: 0.03,
};
const RETURN_RATE_FALLBACK = 0.06;
const RETURN_RATE_PLATINUM_FACTOR = 0.4;

const BRAND_CLAIM_MULTIPLIER: Record<string, number> = { Skechers: 3.0 };
const CLAIM_RATE_BASELINE = 0.025;

const LAX01_WAREHOUSE_CODE = 'LAX01';
const LAX01_SHRINKAGE_LOW = 0.75;
const LAX01_SHRINKAGE_HIGH = 0.90;

const BF_WINDOW_DAYS_BEFORE = 1;
const BF_WINDOW_DAYS_AFTER = 3;
const DISCOUNT_PROB_BASELINE = 0.18;
const DISCOUNT_PROB_BF = 0.55;

// ---------------------------------------------------------------------------
// Schema DDL — the on-disk schema is the public contract.
// ---------------------------------------------------------------------------

const TABLE_NAMES = [
    'warehouses', 'products', 'stock', 'customers',
    'orders', 'order_items', 'returns', 'claims',
] as const;

const SCHEMA_SQL = `
CREATE TABLE warehouses (
    warehouse_id INTEGER PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    city         TEXT NOT NULL,
    country      TEXT NOT NULL
);

CREATE TABLE products (
    product_id   INTEGER PRIMARY KEY,
    sku          TEXT NOT NULL UNIQUE,
    brand        TEXT NOT NULL,
    model        TEXT NOT NULL,
    category     TEXT NOT NULL,
    gender       TEXT NOT NULL,
    color        TEXT NOT NULL,
    size         REAL NOT NULL,
    material     TEXT NOT NULL,
    price_cents  INTEGER NOT NULL,
    cost_cents   INTEGER NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX idx_products_brand    ON products(brand);
CREATE INDEX idx_products_category ON products(category);

CREATE TABLE stock (
    stock_id           INTEGER PRIMARY KEY,
    product_id         INTEGER NOT NULL REFERENCES products(product_id),
    warehouse_id       INTEGER NOT NULL REFERENCES warehouses(warehouse_id),
    quantity_on_hand   INTEGER NOT NULL,
    quantity_reserved  INTEGER NOT NULL,
    last_restock_at    TEXT NOT NULL,
    UNIQUE(product_id, warehouse_id)
);
CREATE INDEX idx_stock_product   ON stock(product_id);
CREATE INDEX idx_stock_warehouse ON stock(warehouse_id);

CREATE TABLE customers (
    customer_id  INTEGER PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    first_name   TEXT NOT NULL,
    last_name    TEXT NOT NULL,
    city         TEXT NOT NULL,
    country      TEXT NOT NULL,
    signup_at    TEXT NOT NULL,
    loyalty_tier TEXT NOT NULL
);
CREATE INDEX idx_customers_country ON customers(country);
CREATE INDEX idx_customers_tier    ON customers(loyalty_tier);

CREATE TABLE orders (
    order_id        INTEGER PRIMARY KEY,
    customer_id     INTEGER NOT NULL REFERENCES customers(customer_id),
    warehouse_id    INTEGER NOT NULL REFERENCES warehouses(warehouse_id),
    order_date      TEXT NOT NULL,
    status          TEXT NOT NULL,
    channel         TEXT NOT NULL,
    subtotal_cents  INTEGER NOT NULL,
    shipping_cents  INTEGER NOT NULL,
    tax_cents       INTEGER NOT NULL,
    total_cents     INTEGER NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date     ON orders(order_date);
CREATE INDEX idx_orders_status   ON orders(status);

CREATE TABLE order_items (
    order_item_id     INTEGER PRIMARY KEY,
    order_id          INTEGER NOT NULL REFERENCES orders(order_id),
    product_id        INTEGER NOT NULL REFERENCES products(product_id),
    quantity          INTEGER NOT NULL,
    unit_price_cents  INTEGER NOT NULL,
    discount_cents    INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order   ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

CREATE TABLE returns (
    return_id      INTEGER PRIMARY KEY,
    order_item_id  INTEGER NOT NULL REFERENCES order_items(order_item_id),
    return_date    TEXT NOT NULL,
    quantity       INTEGER NOT NULL,
    reason         TEXT NOT NULL,
    refund_cents   INTEGER NOT NULL,
    restocked      INTEGER NOT NULL
);
CREATE INDEX idx_returns_order_item ON returns(order_item_id);
CREATE INDEX idx_returns_date       ON returns(return_date);

CREATE TABLE claims (
    claim_id           INTEGER PRIMARY KEY,
    order_item_id      INTEGER NOT NULL REFERENCES order_items(order_item_id),
    customer_id        INTEGER NOT NULL REFERENCES customers(customer_id),
    opened_at          TEXT NOT NULL,
    resolved_at        TEXT,
    category           TEXT NOT NULL,
    severity           TEXT NOT NULL,
    status             TEXT NOT NULL,
    description        TEXT,
    compensation_cents INTEGER
);
CREATE INDEX idx_claims_customer ON claims(customer_id);
CREATE INDEX idx_claims_status   ON claims(status);

CREATE VIEW sales AS
SELECT
    oi.order_item_id,
    o.order_id,
    o.order_date,
    o.customer_id,
    o.channel,
    o.warehouse_id,
    oi.product_id,
    p.brand,
    p.model,
    p.category,
    p.gender,
    p.color,
    oi.quantity,
    oi.unit_price_cents,
    oi.discount_cents,
    (oi.quantity * oi.unit_price_cents - oi.discount_cents) AS net_cents
FROM order_items oi
JOIN orders   o ON o.order_id   = oi.order_id
JOIN products p ON p.product_id = oi.product_id
WHERE o.status IN ('paid','shipped','delivered','refunded');
`;

// ---------------------------------------------------------------------------
// Deterministic PRNG + sampling helpers
// ---------------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
    return arr[Math.floor(rng() * arr.length)]!;
}

function pickWeighted<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
    const r = rng();
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
        acc += weights[i]!;
        if (r < acc) return items[i]!;
    }
    return items[items.length - 1]!;
}

function intBetween(rng: Rng, min: number, max: number): number {
    return Math.floor(rng() * (max - min + 1)) + min;
}

function buildCdf(weights: readonly number[]): Float64Array {
    const cdf = new Float64Array(weights.length);
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
        acc += weights[i]!;
        cdf[i] = acc;
    }
    if (acc > 0) {
        const inv = 1 / acc;
        for (let i = 0; i < cdf.length; i++) cdf[i]! *= inv;
    }
    return cdf;
}

function sampleCdf(rng: Rng, cdf: Float64Array): number {
    const r = rng();
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cdf[mid]! < r) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

const DAY_MS = 86_400_000;
const SIGNUP_START_MS = Date.UTC(2022, 0, 1);
const ORDER_START_MS  = Date.UTC(2024, 0, 1);
const ORDER_END_MS    = Date.UTC(2026, 4, 28);

function isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}
function isoDateTime(ms: number): string {
    return new Date(ms).toISOString();
}

function lastWeekdayOfMonth(year: number, monthZeroIdx: number, weekday: number): number {
    const last = new Date(Date.UTC(year, monthZeroIdx + 1, 0));
    const dow = last.getUTCDay();
    const diff = (dow - weekday + 7) % 7;
    return Date.UTC(year, monthZeroIdx, last.getUTCDate() - diff);
}

// ---------------------------------------------------------------------------
// Internal info types
// ---------------------------------------------------------------------------

interface ProductInfo {
    id: number;
    brand: string;
    category: string;
    color: string;
    price_cents: number;
}

interface OrderItemInfo {
    order_item_id: number;
    customer_id: number;
    customer_tier: string;
    brand: string;
    category: string;
    order_date_ms: number;
    status: string;
    channel: string;
    quantity: number;
    unit_price_cents: number;
}

interface DayBucket {
    ms: number;
    month: number;
    bfWindow: boolean;
}

// ---------------------------------------------------------------------------
// wa-sqlite SQL helpers
// ---------------------------------------------------------------------------

/**
 * Reusable prepared-statement block. wa-sqlite's `statements()` iterator
 * yields one stmt per SQL statement; for INSERTs that we rebind in a loop,
 * the right shape is: enter the iterator (one yield, one stmt), do all the
 * bind+step+reset work in the body, exit (auto-finalize). This wraps that
 * pattern so the call sites stay readable.
 */
async function withPrepared(
    sqlite3: SQLiteAPI,
    db: number,
    sql: string,
    fn: (stmt: number) => Promise<void>,
): Promise<void> {
    for await (const stmt of sqlite3.statements(db, sql)) {
        await fn(stmt);
    }
}

async function execAll(sqlite3: SQLiteAPI, db: number, sql: string): Promise<void> {
    await sqlite3.exec(db, sql);
}

async function scalar<T = unknown>(
    sqlite3: SQLiteAPI,
    db: number,
    sql: string,
): Promise<T | null> {
    let out: T | null = null;
    await sqlite3.exec(db, sql, (row) => {
        out = row[0] as T;
    });
    return out;
}

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedRetailWa(
    sqlite3: SQLiteAPI,
    db: number,
    options: WaSeedOptions = {},
): Promise<WaSeedSummary> {
    const opts = { ...DEFAULTS, ...options };
    const t0 = performance.now();

    const alreadySeeded = await tableExists(sqlite3, db, 'products');
    if (alreadySeeded && !options.force) {
        return summarize(sqlite3, db, t0, false);
    }
    if (alreadySeeded) await dropExisting(sqlite3, db);

    await execAll(sqlite3, db, SCHEMA_SQL);

    const rng = mulberry32(opts.seed);

    await execAll(sqlite3, db, 'BEGIN');
    try {
        const numWarehouses = await insertWarehouses(sqlite3, db);
        const lax01Id = WAREHOUSES.findIndex((w) => w.code === LAX01_WAREHOUSE_CODE) + 1;

        const products = await insertProducts(sqlite3, db, rng, opts.products);
        await insertStock(sqlite3, db, rng, products.length, numWarehouses, lax01Id);

        const customerTiers = new Array<string>(opts.customers);
        const customerCountries = new Array<string>(opts.customers);
        await insertCustomers(
            sqlite3, db, rng, opts.customers, customerTiers, customerCountries,
        );

        const items = await insertOrders(
            sqlite3, db, rng, opts.orders, products, numWarehouses,
            customerTiers, customerCountries,
        );

        await insertReturns(sqlite3, db, rng, items);
        await insertClaims(sqlite3, db, rng, items);
        await execAll(sqlite3, db, 'COMMIT');
    } catch (e) {
        await execAll(sqlite3, db, 'ROLLBACK');
        throw e;
    }

    return summarize(sqlite3, db, t0, true);
}

async function tableExists(
    sqlite3: SQLiteAPI,
    db: number,
    name: string,
): Promise<boolean> {
    // PRAGMA doesn't bind; use a literal with escaping. Names come from the
    // hardcoded TABLE_NAMES list so injection isn't a concern here, but we
    // still defensively quote with single quotes.
    const safe = name.replace(/'/g, "''");
    const v = await scalar<number>(
        sqlite3,
        db,
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${safe}' LIMIT 1`,
    );
    return v !== null;
}

async function dropExisting(sqlite3: SQLiteAPI, db: number): Promise<void> {
    await execAll(
        sqlite3,
        db,
        `DROP VIEW  IF EXISTS sales;
         DROP TABLE IF EXISTS claims;
         DROP TABLE IF EXISTS returns;
         DROP TABLE IF EXISTS order_items;
         DROP TABLE IF EXISTS orders;
         DROP TABLE IF EXISTS stock;
         DROP TABLE IF EXISTS products;
         DROP TABLE IF EXISTS customers;
         DROP TABLE IF EXISTS warehouses;`,
    );
}

async function insertWarehouses(sqlite3: SQLiteAPI, db: number): Promise<number> {
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO warehouses (code, name, city, country) VALUES (?,?,?,?)',
        async (stmt) => {
            for (const w of WAREHOUSES) {
                sqlite3.bind_collection(stmt, [w.code, w.name, w.city, w.country]);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);
            }
        },
    );
    return WAREHOUSES.length;
}

async function insertProducts(
    sqlite3: SQLiteAPI,
    db: number,
    rng: Rng,
    target: number,
): Promise<ProductInfo[]> {
    const out: ProductInfo[] = [];
    const seen = new Set<string>();
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO products ' +
            '(sku, brand, model, category, gender, color, size, material, price_cents, cost_cents, created_at) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        async (stmt) => {
            let id = 1;
            let guard = target * 10;
            while (out.length < target && guard-- > 0) {
                const spec = pick(rng, BRANDS);
                const model = pick(rng, spec.models);
                const gender = pick(rng, GENDERS);
                const color = pick(rng, COLORS);
                const size = pick(rng, SHOE_SIZES);
                const material = pick(rng, MATERIALS);
                const category = rng() < 0.85 ? spec.defaultCategory : pick(rng, CATEGORIES);

                const modelKey = model.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
                const sku = `${spec.brand.slice(0, 3).toUpperCase()}-${modelKey}-${gender[0]!.toUpperCase()}-${color.slice(0, 3).toUpperCase()}-${String(size).replace('.', '_')}`;
                if (seen.has(sku)) continue;
                seen.add(sku);

                const priceDollars = 40 + intBetween(rng, 0, 220);
                const price_cents = priceDollars * 100 - 1;
                const cost_cents = Math.floor(price_cents * (0.35 + rng() * 0.25));
                const created_at = isoDate(SIGNUP_START_MS + Math.floor(rng() * (ORDER_START_MS - SIGNUP_START_MS)));

                sqlite3.bind_collection(stmt, [
                    sku, spec.brand, model, category, gender, color,
                    size, material, price_cents, cost_cents, created_at,
                ]);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);
                out.push({ id, brand: spec.brand, category, color, price_cents });
                id++;
            }
        },
    );
    return out;
}

async function insertStock(
    sqlite3: SQLiteAPI,
    db: number,
    rng: Rng,
    numProducts: number,
    numWarehouses: number,
    lax01Id: number,
): Promise<void> {
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO stock (product_id, warehouse_id, quantity_on_hand, quantity_reserved, last_restock_at) ' +
            'VALUES (?,?,?,?,?)',
        async (stmt) => {
            for (let p = 1; p <= numProducts; p++) {
                for (let w = 1; w <= numWarehouses; w++) {
                    if (rng() >= 0.6) continue;
                    let onHand = intBetween(rng, 0, 250);
                    if (w === lax01Id) {
                        const factor = LAX01_SHRINKAGE_LOW + rng() * (LAX01_SHRINKAGE_HIGH - LAX01_SHRINKAGE_LOW);
                        onHand = Math.floor(onHand * factor);
                    }
                    const reserved = onHand === 0 ? 0 : intBetween(rng, 0, Math.max(1, Math.floor(onHand / 5)));
                    const restock = isoDate(ORDER_START_MS + Math.floor(rng() * (ORDER_END_MS - ORDER_START_MS)));
                    sqlite3.bind_collection(stmt, [p, w, onHand, reserved, restock]);
                    await sqlite3.step(stmt);
                    await sqlite3.reset(stmt);
                }
            }
        },
    );
}

const EMAIL_DOMAINS = [
    'example.com','example.org','example.net','mail.example','demo.invalid',
    'inbox.example','post.example','contoso-mail.example','fabrikam.example',
    'northwindtraders.example','example.local','sample.example',
] as const;

function buildEmail(rng: Rng, fn: string, ln: string, i: number): string {
    const first = fn.toLowerCase().replace(/[^a-z]/g, '');
    const last = ln.toLowerCase().replace(/[^a-z]/g, '');
    const shape = Math.floor(rng() * 5);
    const local = shape === 0 ? `${first}.${last}${i}`
        : shape === 1 ? `${first}${last}${i}`
        : shape === 2 ? `${first[0] ?? 'a'}${last}${i}`
        : shape === 3 ? `${first}_${last}${i}`
        : `${first}.${last[0] ?? 'a'}.${i}`;
    const domain = EMAIL_DOMAINS[Math.floor(rng() * EMAIL_DOMAINS.length)]!;
    return `${local}@${domain}`;
}

async function insertCustomers(
    sqlite3: SQLiteAPI,
    db: number,
    rng: Rng,
    target: number,
    tiersOut: string[],
    countriesOut: string[],
): Promise<void> {
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO customers (email, first_name, last_name, city, country, signup_at, loyalty_tier) ' +
            'VALUES (?,?,?,?,?,?,?)',
        async (stmt) => {
            for (let i = 1; i <= target; i++) {
                const fn = pick(rng, FIRST_NAMES);
                const ln = pick(rng, LAST_NAMES);
                const [country, cities] = pick(rng, COUNTRIES);
                const city = pick(rng, cities);
                const email = buildEmail(rng, fn, ln, i);
                const signup = isoDate(SIGNUP_START_MS + Math.floor(rng() * (ORDER_START_MS - SIGNUP_START_MS)));
                const tier = pickWeighted(rng, LOYALTY_TIERS, LOYALTY_ASSIGNMENT_WEIGHTS);
                sqlite3.bind_collection(stmt, [email, fn, ln, city, country, signup, tier]);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);
                tiersOut[i - 1] = tier;
                countriesOut[i - 1] = country;
            }
        },
    );
}

function buildDayBuckets(): { buckets: DayBucket[]; cdf: Float64Array } {
    const bfDays = new Set<number>();
    const bfWindowDays = new Set<number>();
    const memorialDays = new Set<number>();
    for (let y = 2024; y <= 2026; y++) {
        const bf = lastWeekdayOfMonth(y, 10, 5);
        bfDays.add(bf);
        for (let d = -BF_WINDOW_DAYS_BEFORE; d <= BF_WINDOW_DAYS_AFTER; d++) {
            bfWindowDays.add(bf + d * DAY_MS);
        }
        memorialDays.add(lastWeekdayOfMonth(y, 4, 1));
    }

    const buckets: DayBucket[] = [];
    const weights: number[] = [];
    for (let ms = ORDER_START_MS; ms < ORDER_END_MS; ms += DAY_MS) {
        const d = new Date(ms);
        const dow = d.getUTCDay();
        const month = d.getUTCMonth();
        const dayOfMonth = d.getUTCDate();

        let w = 1.0;
        if (dow === 0 || dow === 6) w *= 1.8;
        if (memorialDays.has(ms)) w *= 2.0;
        if (month === 11 && dayOfMonth <= 23) w *= 1.6;
        const bfWindow = bfWindowDays.has(ms);
        if (bfWindow) w *= 3.5;
        if (bfDays.has(ms)) w *= 1.7;

        buckets.push({ ms, month, bfWindow });
        weights.push(w);
    }
    return { buckets, cdf: buildCdf(weights) };
}

function buildMonthlyProductCdfs(
    products: readonly ProductInfo[],
    productBaseWeights: readonly number[],
): Float64Array[] {
    const cdfs: Float64Array[] = new Array(12);
    for (let m = 0; m < 12; m++) {
        const w = new Array<number>(products.length);
        for (let i = 0; i < products.length; i++) {
            const cat = products[i]!.category;
            const seasonal = SEASONALITY[cat]?.[m] ?? 1.0;
            w[i] = productBaseWeights[i]! * seasonal;
        }
        cdfs[m] = buildCdf(w);
    }
    return cdfs;
}

async function insertOrders(
    sqlite3: SQLiteAPI,
    db: number,
    rng: Rng,
    targetOrders: number,
    products: readonly ProductInfo[],
    numWarehouses: number,
    customerTiers: readonly string[],
    customerCountries: readonly string[],
): Promise<OrderItemInfo[]> {
    const items: OrderItemInfo[] = [];

    // Two separate prepared statements; nest the withPrepared calls so both
    // are alive simultaneously. Outer iterator yields `orderStmt`, inner
    // yields `itemStmt`; both finalize on outer exit.
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO orders ' +
            '(customer_id, warehouse_id, order_date, status, channel, subtotal_cents, shipping_cents, tax_cents, total_cents) ' +
            'VALUES (?,?,?,?,?,?,?,?,?)',
        async (orderStmt) => {
            await withPrepared(
                sqlite3,
                db,
                'INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, discount_cents) ' +
                    'VALUES (?,?,?,?,?)',
                async (itemStmt) => {
                    const productBaseWeights = products.map((p) =>
                        (BRAND_POPULARITY[p.brand] ?? 0.01) * (COLOR_POPULARITY[p.color] ?? 1.0),
                    );
                    const customerWeights = customerTiers.map((t) => LOYALTY_PICK_WEIGHT[t] ?? 1.0);
                    const customerCdf = buildCdf(customerWeights);
                    const { buckets: dayBuckets, cdf: dayCdf } = buildDayBuckets();
                    const monthlyCdfs = buildMonthlyProductCdfs(products, productBaseWeights);

                    let orderItemId = 1;
                    for (let i = 1; i <= targetOrders; i++) {
                        const customerId = sampleCdf(rng, customerCdf) + 1;
                        const tier = customerTiers[customerId - 1]!;
                        const country = customerCountries[customerId - 1]!;
                        const warehouse = intBetween(rng, 1, numWarehouses);

                        const dayIdx = sampleCdf(rng, dayCdf);
                        const day = dayBuckets[dayIdx]!;
                        const dateMs = day.ms + Math.floor(rng() * DAY_MS);
                        const orderDate = isoDateTime(dateMs);

                        const channelWeights = CHANNEL_WEIGHTS_BY_COUNTRY[country] ?? CHANNEL_WEIGHTS_FALLBACK;
                        const channel = pickWeighted(rng, CHANNELS, channelWeights);
                        const statusWeights = channel === 'partner' ? STATUS_WEIGHTS_PARTNER : STATUS_WEIGHTS_DEFAULT;
                        const status = pickWeighted(rng, ORDER_STATUSES, statusWeights);

                        const lines = pickWeighted(rng, LINE_COUNTS, LINE_COUNT_WEIGHTS);
                        const monthCdf = monthlyCdfs[day.month]!;
                        const discountProb = day.bfWindow ? DISCOUNT_PROB_BF : DISCOUNT_PROB_BASELINE;
                        const discountFracBase = day.bfWindow ? 0.10 : 0.05;
                        const discountFracSpan = day.bfWindow ? 0.30 : 0.25;

                        const lineRecords: Array<{
                            product: ProductInfo;
                            qty: number;
                            disc: number;
                        }> = [];
                        let subtotal = 0;
                        for (let l = 0; l < lines; l++) {
                            const prodIdx = sampleCdf(rng, monthCdf);
                            const prod = products[prodIdx]!;
                            const qty = pickWeighted(rng, QUANTITIES, QUANTITY_WEIGHTS);
                            const lineGross = prod.price_cents * qty;
                            const disc = rng() < discountProb
                                ? Math.floor(lineGross * (discountFracBase + rng() * discountFracSpan))
                                : 0;
                            subtotal += lineGross - disc;
                            lineRecords.push({ product: prod, qty, disc });
                        }
                        const shipping = subtotal < 10_000 ? 999 : 0;
                        const tax = Math.floor(subtotal * 0.085);
                        const total = subtotal + shipping + tax;

                        sqlite3.bind_collection(orderStmt, [
                            customerId, warehouse, orderDate, status, channel,
                            subtotal, shipping, tax, total,
                        ]);
                        await sqlite3.step(orderStmt);
                        await sqlite3.reset(orderStmt);
                        const orderId = i;

                        for (const ln of lineRecords) {
                            sqlite3.bind_collection(itemStmt, [
                                orderId, ln.product.id, ln.qty, ln.product.price_cents, ln.disc,
                            ]);
                            await sqlite3.step(itemStmt);
                            await sqlite3.reset(itemStmt);
                            items.push({
                                order_item_id: orderItemId,
                                customer_id: customerId,
                                customer_tier: tier,
                                brand: ln.product.brand,
                                category: ln.product.category,
                                order_date_ms: dateMs,
                                status,
                                channel,
                                quantity: ln.qty,
                                unit_price_cents: ln.product.price_cents,
                            });
                            orderItemId++;
                        }
                    }
                },
            );
        },
    );
    return items;
}

async function insertReturns(
    sqlite3: SQLiteAPI,
    db: number,
    rng: Rng,
    items: readonly OrderItemInfo[],
): Promise<void> {
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO returns (order_item_id, return_date, quantity, reason, refund_cents, restocked) ' +
            'VALUES (?,?,?,?,?,?)',
        async (stmt) => {
            for (const it of items) {
                if (it.status === 'cancelled' || it.status === 'pending') continue;
                const base = RETURN_RATE_BY_CATEGORY[it.category] ?? RETURN_RATE_FALLBACK;
                const rate = it.customer_tier === 'platinum' ? base * RETURN_RATE_PLATINUM_FACTOR : base;
                if (rng() >= rate) continue;

                const qty = intBetween(rng, 1, it.quantity);
                const reason = it.category === 'boots'
                    ? pickWeighted(rng, RETURN_REASONS, RETURN_REASON_WEIGHTS_BOOTS)
                    : pick(rng, RETURN_REASONS);
                const returnMs = it.order_date_ms + DAY_MS * intBetween(rng, 3, 45);
                const refund = qty * it.unit_price_cents;
                const restocked = reason === 'defective' ? 0 : rng() < 0.85 ? 1 : 0;
                sqlite3.bind_collection(stmt, [
                    it.order_item_id, isoDateTime(returnMs), qty, reason, refund, restocked,
                ]);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);
            }
        },
    );
}

async function insertClaims(
    sqlite3: SQLiteAPI,
    db: number,
    rng: Rng,
    items: readonly OrderItemInfo[],
): Promise<void> {
    await withPrepared(
        sqlite3,
        db,
        'INSERT INTO claims ' +
            '(order_item_id, customer_id, opened_at, resolved_at, category, severity, status, description, compensation_cents) ' +
            'VALUES (?,?,?,?,?,?,?,?,?)',
        async (stmt) => {
            for (const it of items) {
                if (it.status === 'cancelled' || it.status === 'pending') continue;
                const multiplier = BRAND_CLAIM_MULTIPLIER[it.brand] ?? 1.0;
                const rate = CLAIM_RATE_BASELINE * multiplier;
                if (rng() >= rate) continue;

                const isSkechers = it.brand === 'Skechers';
                const category = isSkechers
                    ? pickWeighted(rng, CLAIM_CATEGORIES, CLAIM_CATEGORY_WEIGHTS_SKECHERS)
                    : pick(rng, CLAIM_CATEGORIES);
                const severity = pickWeighted(
                    rng, CLAIM_SEVERITIES,
                    isSkechers ? CLAIM_SEVERITY_WEIGHTS_SKECHERS : CLAIM_SEVERITY_WEIGHTS_DEFAULT,
                );
                const status = pickWeighted(rng, CLAIM_STATUSES, CLAIM_STATUS_WEIGHTS);
                const openedMs = it.order_date_ms + DAY_MS * intBetween(rng, 1, 60);
                const resolvedAt = status === 'resolved' || status === 'rejected'
                    ? isoDateTime(openedMs + DAY_MS * intBetween(rng, 1, 30))
                    : null;
                const description = pick(rng, CLAIM_TEMPLATES[category]!);
                const compensation = status === 'resolved' && rng() < 0.7
                    ? Math.floor(it.unit_price_cents * (0.2 + rng() * 0.8))
                    : null;
                sqlite3.bind_collection(stmt, [
                    it.order_item_id, it.customer_id, isoDateTime(openedMs), resolvedAt,
                    category, severity, status, description, compensation,
                ]);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);
            }
        },
    );
}

async function summarize(
    sqlite3: SQLiteAPI,
    db: number,
    t0: number,
    seeded: boolean,
): Promise<WaSeedSummary> {
    const tables: Record<string, number> = {};
    for (const t of TABLE_NAMES) {
        if (!(await tableExists(sqlite3, db, t))) {
            tables[t] = 0;
            continue;
        }
        const safe = t.replace(/"/g, '""');
        const n = await scalar<number>(sqlite3, db, `SELECT COUNT(*) FROM "${safe}"`);
        tables[t] = n ?? 0;
    }
    return { seeded, tables, elapsedMs: Math.round(performance.now() - t0) };
}
