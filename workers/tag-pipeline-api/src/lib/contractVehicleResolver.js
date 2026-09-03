const RULE_TYPES = new Set(['ANY', 'EXACT', 'SET', 'RANGE', 'PREFIX'])

export const CONTRACT_VEHICLE_RULE_HEADERS = [
  'RULE_ID', 'AGENCY', 'VEHICLE_NAME', 'VEHICLE_VARIANT', 'MATCH_MODE',
  'AAC', 'FY_RULE_TYPE', 'FY_RULE', 'INSTRUMENT_CODE',
  'SERIAL_RULE_TYPE', 'SERIAL_RULE', 'FULL_PIID_RULE_TYPE', 'FULL_PIID_RULE',
  'PRIORITY', 'CONFIDENCE', 'ENABLED', 'RULE_ORIGIN', 'SOURCE',
  'LAST_VERIFIED', 'NOTES',
]

const VERIFIED_AT = '2026-09-03'
const SOURCE = {
  research: 'Decode Contract Vehicle IDs research',
  sewp: 'https://www.sewp.nasa.gov/documents/contract_background.pdf',
  eglin: 'https://www.eglin.af.mil/Portals/56/documents/Small_Business_Office/Base%20Contracts%20List.pdf',
  gsa: 'https://www.gsaelibrary.gsa.gov/',
  navsea: 'https://www.navsea.navy.mil/Small-Business-Partnerships/SeaPort-NxG/',
  shield: 'https://www.mda.mil/global/documents/pdf/shield-vendor-list.pdf',
}

function seed(id, agency, vehicle, options = {}) {
  return {
    RULE_ID: id,
    AGENCY: agency,
    VEHICLE_NAME: vehicle,
    VEHICLE_VARIANT: options.variant || '',
    MATCH_MODE: options.matchMode || 'COMPONENTS',
    AAC: options.aac || '',
    FY_RULE_TYPE: options.fyType || (options.fy ? 'EXACT' : 'ANY'),
    FY_RULE: options.fy || '',
    INSTRUMENT_CODE: options.instrument || '',
    SERIAL_RULE_TYPE: options.serialType || 'ANY',
    SERIAL_RULE: options.serial || '',
    FULL_PIID_RULE_TYPE: options.fullType || '',
    FULL_PIID_RULE: options.full || '',
    PRIORITY: options.priority ?? 100,
    CONFIDENCE: options.confidence || 'VERIFIED',
    ENABLED: options.enabled === false ? 'No' : 'Yes',
    RULE_ORIGIN: 'RESEARCH',
    SOURCE: options.source || SOURCE.research,
    LAST_VERIFIED: options.verifiedAt || VERIFIED_AT,
    NOTES: options.notes || '',
  }
}

const SEWP_V_IDS = 'NNG15SC00B,NNG15SC01B,NNG15SC02B,NNG15SC03B,NNG15SC04B,NNG15SC05B,NNG15SC06B,NNG15SC07B,NNG15SC08B,NNG15SC09B,NNG15SC10B,NNG15SC11B,NNG15SC12B,NNG15SC13B,NNG15SC14B,NNG15SC15B,NNG15SC16B,NNG15SC17B,NNG15SC18B,NNG15SC19B,NNG15SC20B,NNG15SC21B,NNG15SC22B,NNG15SC23B,NNG15SC24B,NNG15SC25B,NNG15SC27B,NNG15SC28B,NNG15SC29B,NNG15SC30B,NNG15SC31B,NNG15SC33B,NNG15SC34B,NNG15SC35B,NNG15SC36B,NNG15SC37B,NNG15SC38B,NNG15SC39B,NNG15SC40B,NNG15SC41B,NNG15SC42B,NNG15SC43B,NNG15SC44B,NNG15SC45B,NNG15SC46B,NNG15SC47B,NNG15SC48B,NNG15SC49B,NNG15SC50B,NNG15SC51B,NNG15SC52B,NNG15SC53B,NNG15SC54B,NNG15SC55B,NNG15SC56B,NNG15SC57B,NNG15SC58B,NNG15SC59B,NNG15SC60B,NNG15SC61B,NNG15SC62B,NNG15SC63B,NNG15SC64B,NNG15SC65B,NNG15SC66B,NNG15SC67B,NNG15SC68B,NNG15SC69B,NNG15SC70B,NNG15SC71B,NNG15SC72B,NNG15SC73B,NNG15SC74B,NNG15SC75B,NNG15SC76B,NNG15SC77B,NNG15SC78B,NNG15SC79B,NNG15SC80B,NNG15SC81B,NNG15SC82B,NNG15SC83B,NNG15SC84B,NNG15SC85B,NNG15SC86B,NNG15SC87B,NNG15SC88B,NNG15SC89B,NNG15SC90B,NNG15SC91B,NNG15SC92B,NNG15SC93B,NNG15SC94B,NNG15SC95B,NNG15SC96B,NNG15SC97B,NNG15SC98B,NNG15SD00B,NNG15SD01B,NNG15SD02B,NNG15SD03B,NNG15SD04B,NNG15SD05B,NNG15SD06B,NNG15SD07B,NNG15SD08B,NNG15SD09B,NNG15SD10B,NNG15SD11B,NNG15SD12B,NNG15SD13B,NNG15SD18B,NNG15SD19B,NNG15SD20B,NNG15SD21B,NNG15SD22B,NNG15SD23B,NNG15SD24B,NNG15SD25B,NNG15SD26B,NNG15SD27B,NNG15SD28B,NNG15SD29B,NNG15SD30B,NNG15SD31B,NNG15SD32B,NNG15SD33B,NNG15SD34B,NNG15SD35B,NNG15SD36B,NNG15SD37B,NNG15SD38B,NNG15SD39B,NNG15SD41B,NNG15SD42B,NNG15SD43B,NNG15SD45B,NNG15SD46B,NNG15SD48B,NNG15SD49B,NNG15SD50B,NNG15SD51B,NNG15SD52B,NNG15SD53B,NNG15SD54B,NNG15SD55B,NNG15SD56B,NNG15SD57B,NNG15SD58B,NNG15SD59B,NNG15SD60B,NNG15SD61B,NNG15SD62B,NNG15SD63B,NNG15SD64B,NNG15SD65B,NNG15SD66B,NNG15SD67B,NNG15SD68B,NNG15SD69B,NNG15SD70B,NNG15SD71B,NNG15SD72B,NNG15SD73B,NNG15SD74B,NNG15SD76B,NNG15SD77B,NNG15SD78B,NNG15SD79B,NNG15SD80B,NNG15SD81B,NNG15SD82B,NNG15SD83B,NNG15SD84B,NNG15SD85B,NNG15SD86B,NNG15SD87B,NNG15SD88B,NNG15SD89B,NNG15SD90B,NNG15SD91B,NNG15SD92B,NNG15SD93B,NNG15SD94B,NNG15SE01B,NNG15SE02B,NNG15SE04B,NNG15SE05B,NNG15SE07B,NNG15SE08B,NNG15SE09B,NNG15SE10B,NNG15SE11B,NNG15SE12B,NNG15SE13B,NNG15SE14B,NNG15SE16B'

const DOE_ESPC_GEN2_IDS = 'DEAM3609GO29029,DEAM3609GO29030,DEAM3609GO29031,DEAM3609GO29032,DEAM3609GO29033,DEAM3609GO29034,DEAM3609GO29035,DEAM3609GO29036,DEAM3609GO29037,DEAM3609GO29038,DEAM3609GO29039,DEAM3609GO29040,DEAM3609GO29041,DEAM3609GO29042,DEAM3609GO29043,DEAM3609GO29044'

const EWAAC_21 = 'A002,A003,A004,A005,A006,A007,A008,A009,A010,A011,A013,A014,A015,A016,A017,A018,A019,A020,A021,A022,A023,A024,A025,A026,A027,A028,A029,A030,A031,A032,A033,A034,A035,A036,A037,A038,A039,A040,A041,A042,A043,A044,A045,A046,A047,A048,A049,A050,A053,A054,A055,A056,A057,A058,A059'
const EWAAC_22 = 'A001,A002,A003,A004,A005,A006,A007,A008,A009,A010,A011,A012,A013,A014,A015,A016,A017,A018,A019,A020,A021,A022,A023,A024,A025,A026,A027,A028,A029,A030,A031,A032,A033,A034,A035,A036,A038,A039,A040,A042,A043,A044,A045,A046,A047,A048,A049,A050,A051,A052,A053,A054,A055,A056,A057,A058,A059,A060'
const EWAAC_23 = 'A002,A003,A004,A005,A006,A007,A008,A009,A011,A012,A013,A015,A016,A017,A018,A019,A020,A021,A022,A023,A024,A025,A026,A027,A028,A029,A030,A031,A057,A058,A059,A060,A062,A063,A064,A065,A066,A067,A068,A069,A070,A071,A072,A073,A074,A076,A077,A079,A080,A081,A082,A083,A084,A085,A086,A087,A090,A091,A092,A093,A094,A095,A096'

// Collision-prone MAS families are exact serial rosters, grouped by AAC and fiscal year.
// They come from the official GSA eLibrary MAS roster downloaded on LAST_VERIFIED.
const MAS_EXACT_SERIAL_SETS = [
  ['47QSEA', '18', '0006,000A,000V,000Y,001Q,003W,008C'],
  ['47QSEA', '19', '0002,000A,000B,001G,0037,004Q,0065,0069,006Y,006Z,0074,007U,008E,008T,0094,009B,00AY,00B9,00BR,00BV,00C4,00C9,00CT,00CY'],
  ['47QSEA', '20', '0005,000P,000W,001A,001N,001S,001T,0021,002H,002J,002N,002Q,003B,003D,003J,003Q,003U,0042,0043,0046,004Q,004W,005C,005G,005H,005K,005N,005Q,005X,0060,0061,0063,0079,007B,007L,007X,0083,008E,0096,009G,009W,009X,00A0'],
  ['47QSEA', '21', '000C,003C,003G,004D,004T,0051,0070,007Y'],
  ['47QSEA', '22', '000M,001S,0027,003J,0047,004H,004J,004P'],
  ['47QSEA', '23', '0007,0008,000R,001P,001Y,0021,002E,002U,002Y,002Z,0031,0033,0037,0038,003B,003J,0042,0044,0045,0046,004B,004N,005Q'],
  ['47QSEA', '24', '0005,000E'],
  ['47QSHA', '18', '000D,000G,000H,000K,000L,000M,000N,000P,000U,000V,000W,000Y,000Z,0011,0016,001A,001B,001E,001F,001K,001Y,001Z,0023,0027,002C,002K,002M'],
  ['47QSHA', '19', '0001,0007,0009,000H,000L,0018,001F,001J,001K,001L,001Q,001U,001X,0020,0027,002E,002R,002S,002V,003F,003H,003J,003T,003U,003W,003Y,0044,0046,0047,004A,004F,004J,004K,004L,004S,004U,004Z,0050,0053,005E,005H,005K,005N,005R,005V,005X,0062'],
  ['47QSHA', '20', '0001,0004,0005,000B,000H,000K,000N,000P,000Q,000R,000U,000V,000W,000Y,000Z,0011,0012,0018,0019,001E,001F,001G,001H,001P,001S,0021,0023,0024,0027,0028,0029,002L,002M,002Q,002T,0031,0037,0039,003E'],
  ['47QSHA', '21', '0004,000A,000D,000H,000R,000T,000Y,000Z,0012,0015,001A,001D,001G,001H,001P,001Q,001R,001Y,0029,002D,002G,002H,002J,002K,002L,002M,002Q,002Z'],
  ['47QSHA', '22', '0002,0007,0008,0009,000C,000D,000F,000G,000J,000K,000N,000P,000Q,000R,000S,000T,000U,000W,000X,000Y,000Z,0011,0012,0015,0016,0017,0018,0019,001A,001D,001H,001J,001P,001Q,001R,001S,001Y,001Z,0020,0021,0022,0026,0028,0029,002A,002B,002C,002L,002M,002N,002Q,002R'],
  ['47QSHA', '23', '0001,0002,0004,0005,000J,000P,000V,000Y,0010,0012,0013,0014,0015,0017,0018,001A,001B,001D,001E,001F,001G,001L,001M,001N,001Q,001R'],
  ['47QSHA', '24', '0001,0003,0004,0005,0006'],
  ['47QSMA', '18', '0004,0006,0007,08NK,08NQ,08NW,08P2,08PC,08PE,08PN,08PR,08PU,08Q9,08QA,08QC,08QG,08QH,08QQ,08QU,08QV,08QX,08R0,08R2,08R3,08R6,08R8,08R9'],
  ['47QSMA', '19', '08N8,08NB,08ND,08NF,08NH,08NK,08NL,08NN,08NT,08NW,08NX,08P0,08P2,08P3,08P6,08P7,08P8,08P9,08PA,08PC,08PD,08PH,08PL,08PN,08PR,08PW,08PY,08Q1,08Q9,08QB,08QC,08QD,08QF,08QG,08QJ,08QM,08QR,08QT,08QV,08QW,08QZ,08R0,08R1,08R2,08R3,08R6,08R8,08RB'],
  ['47QSMA', '20', '08NA,08NC,08NF,08NH,08NJ,08NK,08NL,08NN,08NQ,08NR,08P0,08P2,08P7,08P8,08PD,08PE,08PH,08PJ,08PS,08PT,08PV,08Q1,08Q2,08Q3,08Q4,08Q5,08QC,08QE,08QG,08QQ,08QU,08QV,08QX'],
  ['47QSMA', '21', '08NA,08NC,08NH,08NJ,08NL,08NM,08NQ,08NR,08NV,08NX,08NY,08P1,08P2,08P5,08PA,08PD,08PL,08PQ,08PS,08PU,08PW,08Q4,08QC,08QD,08QE,08QF,08QP,08QR,08QU,08QV,08R3,08R4,08R7,08R8,08R9,08RA,08RB,08RD,08RF,08RG'],
  ['47QSMA', '22', '08N7,08N8,08N9,08NC,08ND,08NG,08NK,08NN,08NP,08NQ,08NR,08NT,08NU,08NV,08NW,08NX,08NZ,08P1,08P4,08P5,08P6,08P7,08P9,08PA,08PB,08PC,08PD,08PE,08PF,08PJ,08PQ,08PR,08PS,08PU,08PV,08PW,08PX,08PZ,08Q0,08Q2,08Q3,08Q4,08Q5,08Q6,08Q7,08Q8,08Q9,08QB,08QF,08QH,08QJ,08QK,08QL,08QM,08QQ'],
  ['47QSMA', '23', '08N5,08N8,08N9,08NA,08NB,08ND,08NE,08NG,08NJ,08NK,08NL,08NM,08NN,08NP,08NQ,08NR,08NS,08NU,08NV,08NW,08NX,08NY,08NZ,08P0,08P1,08P2,08P4,08P7,08P8,08PA,08PB,08PD,08PE,08PG,08PH,08PK,08PL,08PN,08PP,08PQ,08PR,08PS,08PT,08PU,08PV,08PX,08PY,08PZ,08Q1,08Q3,08Q4,08Q5,08Q6,08Q8,08Q9,08QA,08QB,08QC,08QD,08QF,08QG,08QK,08QL,08QN,08QR,08QS,08QT,08QU'],
  ['47QSMA', '24', '08N5,08N6,08N7,08N8,08N9,08NA,08NB'],
  ['47QSSC', '24', '0019,001B'],
  ['47QSWA', '17', '0001,0002'],
  ['47QSWA', '18', '0006,0007,000E,000J,000K,000Q,000T,000U,000V,000Y,000Z,0011,0013,0015,0016,001C,001D,001E,001F,001H,001N,001P,001S,001U,001W,001X,001Z,0022,0023,0025,002B,002C,002G,002H,002M,002P,0030,0034,003A,003B,003K,003X,0041,0043,004E,004R,004V,0050,0056,0057,005A,005J,005S,005X,0062,0063,0068,006B,006V,0075,007A,007B,007C,007Y,0080,0084,0087,0089,008B,008C,008D,008E,008F,008J,008K,008L,008Q,008T,008W,008X,0096,009D,009F,009G,009J,009K,009L,009Y,00AD,00AE,00AM'],
  ['47QSWA', '19', '0007,000E,000K,000L,000M,000Y,0019,001D,001E,001F,001H,001J,001M,001R,001W,0026,002C,002E,002G,002J,002N,002R,002S,002W,002X,0030,0031,0035,0036,003D,003H,003J,003X,0044,004A,004B,004F,004G,004H,004L,004M,004X,0051,0053,0056,0059,005G,005P,005Y,005Z,0062,0068,0069,006F,006L,0073,007L,007M,007N,007Q,007T,0088,008B,008C,008R,008U,008X,0090,0096,0099,009C,009H,009K,009M,009N,009V,00AE,00AL,00AM,00AP'],
  ['47QSWA', '20', '0005,0006,0007,0008,0009,000B,000C,000E,000F,000H,000K,000M,000N,000Q,000R,000S,000V,000X,000Y,0010,0011,0015,0016,001M,001P,0021,0023,002A,002B,002D,002F,002G,002H,002J,002K,002R,002T,002U,002X,0032,0033,0035,0036,0037,003A,003H,003J,003Y,003Z,0043,0044,0047,004D,004K,005C,005M,005R,0063,0068,006C,006F,006G,0078,007M,007Q,007S,007X,008M,008R,008W,008Z,0092,0095,009C,009F,009H,009W,009Z,00A7,00A9,00AG,00AH,00AR,00AU'],
  ['47QSWA', '21', '0004,0006,000E,000G,000M,0010,001S,0022,0023,0025,0026,0031,003R,003T,003V,003W,004C,004D,004H,004J,004M,0055,005A,005H,005N,005U,005Z,0062,006G,006P,006Q,006R,0075,0078,0079,007B,0083,0085,0086,0088,0089,008B,008C,008F,008G,008H,008K'],
  ['47QSWA', '22', '0002,0004,0005,0006,000B,000H,000K,000M,000N,000U,000Y,0012,0018,0019,001A,001D,001J,001L,001M,001P,001Q,001R,001X,001Y,001Z,0023,002E,002L,002Q,002S,002W,002Z,0032,0033,0036,0039,003A,003M,003N,003Q,003S,003U,0040,0041,0045,0046,004E,004F,004G,004J,004N,004P,004R,0051,0052,0053,0058,0059,005C,005J,005L,005M,005P,005S,005V,005Y,005Z,0060,0065,0067,0069,006C,006D,006E,006F,006K,006L,006M,006Q,0070,0072,0077,007B,007C,007F,007G,007J,007L,007N,007P,007Q,0080,0084,0086,0088,0089,008A,008B,008L,008U,008V,0092,0098,0099,009E,009N,009R,009S,009X,009Y,00A4,00A5,00A7,00AA,00AB,00AC,00AE,00AF,00AJ'],
  ['47QSWA', '23', '0008,0009,000C,000D,000J,000M,000Q,000S,000Y,000Z,0016,0017,001C,001E,001F,001Q,001X,001Z,0025,0026,0027,0028,002A,002C,002E,002G,002H,002J,002K,002P,002R,002S,002V,002W,002X,0031,0032,0033,0035,0036,0037,003D,003J,003K,003R,003U,003W,003Z,0041,0047,004A,004B,004E,004J,004R,004T,004U,004Y,0052,0053,0054,0056,0057,0058,0059,005A,005C,005E,005J,005P,005Q,005V,005X,0062,0066,0068,0069,006A,006H,006J,006P,006U,006X,006Z,0070,0072,0076,0079,007A,007B,007C,007F,007G,007L,007M,007Q,007R,007S,007T,007U,007V,007X,0084,0085,0086,0087,0088,0089,008A,008B,008D,008F,008S,008T,008Z,0090,0091,0092,0097,009B,009C,009E,009K,009L,009R,009S,009U,009V,009W,00A1,00A2,00A3,00A6,00A7,00A8,00A9'],
  ['47QSWA', '24', '0007,0009,000A,000B,000F,000G,000H,000J,000R,000T,000V,000W,000Y'],
]

const COMPONENT_RULES = [
  ...MAS_EXACT_SERIAL_SETS.map(([aac, fiscalYear, serials]) => [
    `gsa-mas-${aac.toLowerCase()}-${fiscalYear}`, 'GSA', 'Multiple Award Schedule', {
      aac, fy: fiscalYear, instrument: 'D', serialType: 'SET', serial: serials,
      priority: 250, source: SOURCE.gsa,
      notes: 'Exact current-contract roster from GSA eLibrary; used because this AAC also contains non-MAS awards.',
    },
  ]),
  ['gsa-alliant-2', 'GSA', 'Alliant 2', { aac: '47QTCK', fy: '18', instrument: 'D' }],
  ['gsa-alliant-3', 'GSA', 'Alliant 3', { aac: '47QTCB', fy: '26', instrument: 'D' }],
  ['gsa-vets-2', 'GSA', 'VETS 2', { aac: '47QTCH', fy: '18', instrument: 'D' }],
  ['gsa-stars-iii', 'GSA', '8(a) STARS III', { aac: '47QTCB', fyType: 'SET', fy: '21,22', instrument: 'D' }],
  ...[['A', '8(a)'], ['H', 'HUBZone'], ['S', 'Small Business'], ['V', 'SDVOSB'], ['W', 'WOSB'], ['U', 'Unrestricted']].map(([prefix, variant]) => [
    `gsa-oasis-plus-${prefix.toLowerCase()}`, 'GSA', 'OASIS+', { variant, aac: '47QRCA', fyType: 'SET', fy: '25,26', instrument: 'D', serialType: 'PREFIX', serial: prefix, source: SOURCE.gsa },
  ]),
  ...[['H', 'HUBZone'], ['V', 'SDVOSB'], ['W', 'WOSB']].map(([prefix, variant]) => [
    `gsa-polaris-${prefix.toLowerCase()}`, 'GSA', 'Polaris', { variant, aac: '47QTCC', fy: '26', instrument: 'D', serialType: 'PREFIX', serial: prefix },
  ]),
  ['gsa-astro', 'GSA', 'ASTRO', { aac: '47QFCA', fy: '22', instrument: 'D' }],
  ['gsa-bmo-u2', 'GSA', 'BMO Unrestricted Phase 2', { aac: '47QSHA', fy: '18', instrument: 'D', serialType: 'SET', serial: '0005,0006,0007,0008,0009,000A,000B,000C', priority: 300, source: SOURCE.gsa, notes: '000D is deliberately excluded because it is a MAS collision.' }],
  ['disa-encore-iii-fo', 'DISA', 'ENCORE III', { variant: 'Full & Open', aac: 'HC1028', fy: '18', instrument: 'D', serialType: 'RANGE', serial: '0001:0020' }],
  ['disa-encore-iii-sb', 'DISA', 'ENCORE III', { variant: 'Small Business', aac: 'HC1028', fy: '18', instrument: 'D', serialType: 'RANGE', serial: '0021:0040' }],
  ['disa-seti-18', 'DISA', 'SETI', { variant: 'Unrestricted', aac: 'HC1047', fy: '18', instrument: 'D', serialType: 'RANGE', serial: '2001:2014' }],
  ['disa-seti-19-corrective', 'DISA', 'SETI', { variant: 'Unrestricted corrective award', aac: 'HC1047', fy: '19', instrument: 'D', serialType: 'EXACT', serial: '2015' }],
  ['disa-seti-19-sb', 'DISA', 'SETI', { variant: 'Small Business', aac: 'HC1047', fy: '19', instrument: 'D', serialType: 'RANGE', serial: '2020:2042' }],
  ['dia-site-iii', 'DIA', 'SITE III', { aac: 'HHM402', fy: '21', instrument: 'D', serialType: 'RANGE', serial: '0003:0146' }],
  ['af-sbeas', 'Air Force', 'SBEAS', { aac: 'FA8771', fy: '20', instrument: 'D', serialType: 'RANGE', serial: '0001:0020' }],
  ['dha-omnibus-iv', 'DHA', 'Omnibus IV', { aac: 'HT0011', fy: '22', instrument: 'D', serialType: 'RANGE', serial: '0001:0056' }],
  ['dla-jets-2', 'DLA', 'JETS 2.0', { aac: 'SP4709', fyType: 'SET', fy: '24,25', instrument: 'D' }],
  ['army-ites-sw2-0039', 'Army', 'ITES-SW2', { aac: 'W52P1J', fy: '20', instrument: 'D', serialType: 'EXACT', serial: '0039' }],
  ['army-ites-sw2-range', 'Army', 'ITES-SW2', { aac: 'W52P1J', fy: '20', instrument: 'D', serialType: 'RANGE', serial: '0041:0070', notes: '0040 is deliberately excluded.' }],
  ['faa-efast', 'FAA', 'eFAST', { aac: '693KA9', fyType: 'SET', fy: '18,19,20,22,23', instrument: 'A' }],
  ['va-iht-2', 'VA', 'IHT 2.0', { aac: '36C10X', fy: '25', instrument: 'D', serialType: 'RANGE', serial: '0017:0025' }],
  ['va-t4ng2-24', 'VA', 'T4NG2', { aac: '36C10B', fy: '24', instrument: 'D', serialType: 'RANGE', serial: '0001:0031' }],
  ['va-t4ng2-25', 'VA', 'T4NG2', { aac: '36C10B', fy: '25', instrument: 'D', serialType: 'RANGE', serial: '0012:0014' }],
  ['state-gata-iii', 'State', 'GATA III', { aac: '19AQMM', fy: '24', instrument: 'D', serialType: 'RANGE', serial: '0039:0042' }],
  ['state-evolve-fc1-26', 'State', 'EVOLVE', { variant: 'FC1 IT Management Services', aac: '19AQMM', fy: '26', instrument: 'D', serialType: 'RANGE', serial: '0173:0183' }],
  ['state-evolve-fc2-25', 'State', 'EVOLVE', { variant: 'FC2 Cloud & Data Center', aac: '19AQMM', fy: '25', instrument: 'D', serialType: 'SET', serial: '0772,0773,0774,0776,0777,0778,0780,0781,0801,1023,1024,1067,1115' }],
  ['state-evolve-fc2-26', 'State', 'EVOLVE', { variant: 'FC2 Cloud & Data Center', aac: '19AQMM', fy: '26', instrument: 'D', serialType: 'EXACT', serial: '0082' }],
  ['state-evolve-fc3-26', 'State', 'EVOLVE', { variant: 'FC3 Application Development', aac: '19AQMM', fy: '26', instrument: 'D', serialType: 'RANGE', serial: '0063:0075' }],
  ['state-evolve-fc4-25', 'State', 'EVOLVE', { variant: 'FC4 Network & Telecommunications', aac: '19AQMM', fy: '25', instrument: 'D', serialType: 'SET', serial: '0301,0302,0303,0304,0305,0962' }],
  ['state-evolve-fc5-25', 'State', 'EVOLVE', { variant: 'FC5 Customer & End User Support', aac: '19AQMM', fy: '25', instrument: 'D', serialType: 'SET', serial: '0432,0433,0434,0965' }],
  ['usda-stratus-p1', 'USDA', 'STRATUS', { variant: 'Pool 1', aac: '123144', fy: '24', instrument: 'G', serialType: 'SET', serial: '0011,0052,0053' }],
  ['navy-seaport-nxg-19', 'Navy', 'SeaPort-NxG', { variant: 'Original cohort', aac: 'N00178', fy: '19', instrument: 'D', serialType: 'RANGE', serial: '7001:8870', confidence: 'ASSUMED_HIGH', source: SOURCE.navsea, notes: 'Enabled documented inference: the inclusive range contains exactly the Navy-announced 1,870 original awards.' }],
  ['af-ewaac-21', 'Air Force', 'EWAAC', { variant: 'Base awards', aac: 'FA8656', fy: '21', instrument: 'D', serialType: 'SET', serial: EWAAC_21, source: SOURCE.eglin }],
  ['af-ewaac-22', 'Air Force', 'EWAAC', { variant: 'First on-ramp', aac: 'FA8656', fy: '22', instrument: 'D', serialType: 'SET', serial: EWAAC_22, source: SOURCE.eglin }],
  ['af-ewaac-23', 'Air Force', 'EWAAC', { variant: 'Second and third on-ramps', aac: 'FA8656', fy: '23', instrument: 'D', serialType: 'SET', serial: EWAAC_23, source: SOURCE.eglin }],
  ['gsa-mas-47qtca', 'GSA', 'Multiple Award Schedule', { aac: '47QTCA', fyType: 'RANGE', fy: '17:26', instrument: 'D', priority: 10, source: SOURCE.gsa, notes: 'Broad MAS cohort rule from the completed collision audit.' }],
  ['gsa-mas-47qraa', 'GSA', 'Multiple Award Schedule', { aac: '47QRAA', fyType: 'RANGE', fy: '18:26', instrument: 'D', priority: 10, source: SOURCE.gsa, notes: 'Broad MAS cohort rule from the completed collision audit.' }],
  ['gsa-mas-47qrea', 'GSA', 'Multiple Award Schedule', { aac: '47QREA', fyType: 'RANGE', fy: '18:26', instrument: 'D', priority: 10, source: SOURCE.gsa, notes: 'Restricted to verified modern cohorts.' }],
  ['gsa-mas-47qsms', 'GSA', 'Multiple Award Schedule', { aac: '47QSMS', fyType: 'RANGE', fy: '24:26', instrument: 'D', priority: 10, source: SOURCE.gsa, notes: 'Modern MAS contracting-division cohorts.' }],
  ['mda-shield-e', 'MDA', 'SHIELD', { aac: 'HQ0859', fy: '26', instrument: 'D', serialType: 'PREFIX', serial: 'E', confidence: 'ASSUMED_HIGH', source: SOURCE.shield, notes: 'Enabled documented inference from MDA’s official 2,400+ contract-holder roster.' }],
  ['mda-shield-f', 'MDA', 'SHIELD', { aac: 'HQ0859', fy: '26', instrument: 'D', serialType: 'PREFIX', serial: 'F', confidence: 'ASSUMED_HIGH', source: SOURCE.shield, notes: 'Enabled documented inference from MDA’s official 2,400+ contract-holder roster.' }],
  ['mda-shield-g', 'MDA', 'SHIELD', { aac: 'HQ0859', fy: '26', instrument: 'D', serialType: 'PREFIX', serial: 'G', confidence: 'ASSUMED_HIGH', source: SOURCE.shield, notes: 'Enabled documented inference from MDA’s official 2,400+ contract-holder roster.' }],
  ['candidate-sewp-vi', 'NASA', 'SEWP VI', { aac: '80TECH', fy: '26', instrument: 'D', confidence: 'CANDIDATE', enabled: false, notes: 'Disabled until NASA publishes a complete award roster.' }],
  ['candidate-fbi-itsss-2', 'FBI', 'ITSSS-2', { aac: '15F067', fy: '24', instrument: 'A', serialType: 'RANGE', serial: '0295:0389', confidence: 'CANDIDATE', enabled: false, notes: 'Candidate range; disabled pending collision verification.' }],
]

export const DEFAULT_CONTRACT_VEHICLE_RULES = [
  seed('nasa-sewp-v', 'NASA', 'NASA SEWP V', { matchMode: 'FULL_PIID', fullType: 'SET', full: SEWP_V_IDS, priority: 500, source: SOURCE.sewp }),
  seed('doe-espc-gen2', 'DOE', 'DOE ESPC Gen2', { matchMode: 'FULL_PIID', fullType: 'SET', full: DOE_ESPC_GEN2_IDS, priority: 500, source: 'https://www.energy.gov/cmei/femp/2008-doe-idiq-espc-energy-service-companies', notes: 'Complete official roster for the 2008 DOE IDIQ ESPC cohort.' }),
  seed('nitaac-cio-sp3-family', 'NIH', 'CIO-SP3', { matchMode: 'FULL_PIID', fullType: 'PREFIX', full: 'HHSN3162012', priority: 450, source: 'https://nitaac.nih.gov/gwacs/cio-sp3' }),
  seed('nitaac-cio-sp3-sb-ramp-on-family', 'NIH', 'CIO-SP3', { variant: 'Small Business Ramp-On', matchMode: 'FULL_PIID', fullType: 'PREFIX', full: '75N98120D', priority: 450, source: 'https://nitaac.nih.gov/resources/announcements/cio-sp3-small-business-sb-ramp-solicitation-number-nihjt2016015-award', notes: 'NITAAC FY2020 CIO-SP3 Small Business ramp-on award family.' }),
  seed('nitaac-cio-cs-family', 'NIH', 'CIO-CS', { matchMode: 'FULL_PIID', fullType: 'PREFIX', full: 'HHSN3162015', priority: 450, source: 'https://nitaac.nih.gov/gwacs/cio-cs' }),
  seed('nih-soar-2021-cohort', 'NIH', 'NIH SOAR', { aac: '75N950', fy: '21', instrument: 'D', serialType: 'SET', serial: '00010,00011,00012,00013,00019', priority: 500, source: 'https://sam.gov/opp/1cc85de296814d4094fa5561d20f3901/view', notes: 'Scientific, Operations, and Administrative Resources award cohort verified against cached SAM work and public award records.' }),
  seed('niaid-pstss-2019-cohort', 'NIH', 'NIAID Professional, Scientific, and Technical Support Services', { aac: '75N930', fy: '19', instrument: 'D', serialType: 'RANGE', serial: '00023:00027', priority: 500, source: 'https://www.nih.gov/sites/default/files/institutes/foia/20211214-foia-log-2021.pdf', notes: 'Five-award cohort issued under solicitation NIHAO201800006.' }),
  seed('nih-ae-matoc-2020-cache-cohort', 'NIH', 'NIH Architect-Engineering MATOC', { aac: '75N990', fy: '20', instrument: 'D', serialType: 'SET', serial: '00005,00008,00010', priority: 500, source: 'https://sam.gov/opp/a55bdd976cbf459dbd62b92888be1e61/view', notes: 'Verified members present in the priority-agency cache; intentionally not widened to unverified serials.' }),
  seed('gsa-legacy-schedule-families', 'GSA', 'GSA MAS', { matchMode: 'FULL_PIID', fullType: 'PREFIX', full: 'GS00F,GS02F,GS03F,GS07F,GS10F,GS35F', priority: 350, confidence: 'ASSUMED_HIGH', source: SOURCE.gsa, notes: 'Legacy Federal Supply Schedule families observed in the priority-agency cache; excludes GS00Q vehicle families.' }),
  seed('gsa-oasis-unrestricted-legacy', 'GSA', 'OASIS', { variant: 'Unrestricted', matchMode: 'FULL_PIID', fullType: 'PREFIX', full: 'GS00Q14OADU', priority: 450, source: 'https://www.gsa.gov/oasis' }),
  seed('gsa-oasis-sb-2020-family', 'GSA', 'OASIS', { variant: 'Small Business', aac: '47QRAD', fy: '20', instrument: 'D', serialType: 'PREFIX', serial: '1', priority: 350, source: 'https://www.gsa.gov/oasis' }),
  seed('gsa-oasis-8a-2020-family', 'GSA', 'OASIS', { variant: '8(a)', aac: '47QRAD', fy: '20', instrument: 'D', serialType: 'PREFIX', serial: '8', priority: 350, source: 'https://www.gsa.gov/oasis' }),
  seed('va-t4ng-family', 'VA', 'T4NG', { matchMode: 'FULL_PIID', fullType: 'PREFIX', full: 'VA11816D10', priority: 450, source: 'https://department.va.gov/procurement-acquisition-and-logistics/technology-acquisition-center/' }),
  seed('disa-jwcc-family', 'DISA', 'JWCC', { aac: 'HC1050', fy: '23', instrument: 'D', serialType: 'RANGE', serial: '0002:0005', priority: 450, source: 'https://www.disa.mil/NewsandEvents/2022/JWCC-Contract-Award' }),
  seed('dcsa-administrative-support-hs002120d0002', 'DCSA', 'DCSA Administrative Support Services', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: 'HS002120D0002', priority: 500, source: 'https://www.defense.gov/News/Contracts/Contract/Article/2011286/', notes: 'Single-award DCSA IDIQ; exact matching prevents collision with unrelated DCSA contracts.' }),
  seed('dcsa-communications-support-hs002124de001', 'DCSA', 'DCSA Communication Operations Support', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: 'HS002124DE001', priority: 500, source: SOURCE.research, notes: 'Single-award DCSA IDIQ; exact matching is required.' }),
  seed('dha-mpass-ht942523d0002', 'DHA', 'DHA MPASS', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: 'HT942523D0002', priority: 500, source: 'https://www.defense.gov/News/Contracts/Contract/Article/3254268/', notes: 'Meeting, Programmatic, and Administrative Support Services single-award IDIQ.' }),
  seed('army-usace-nwk-htrw-2021', 'Army', 'USACE Kansas City HTRW 2021 MATOC', { aac: 'W912DQ', fy: '21', instrument: 'D', serialType: 'RANGE', serial: '3000:3009', priority: 500, source: 'https://www.nwk.usace.army.mil/Business-With-Us/Small-Business/MATOC-SATOC/', notes: 'Official Kansas City District roster.' }),
  seed('army-usace-lrl-afrc-ae-2021-cache-cohort', 'Army', 'USACE AFRC Nationwide A/E MATOC', { aac: 'W912QR', fy: '21', instrument: 'D', serialType: 'SET', serial: '0070,0073', priority: 500, source: 'https://www.federalcompass.com/fed-contract-award/W912QR21D0073', notes: 'Verified unrestricted-pool members present in the cached expiring-contract population; not widened across adjacent small-business pools.' }),
  seed('army-usace-lrl-army-reserve-ae-w912qr21d0026', 'Army', 'USACE Army Reserve A/E IDIQ', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: 'W912QR21D0026', priority: 500, source: 'https://www.federalcompass.com/award-contract-detail/W912QR21D0026', notes: 'Exact member currently present in the cache; adjacent serials can represent different Louisville District pools.' }),
  seed('nasa-nacs-80arc018d0010', 'NASA', 'NASA Advanced Computing Services', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: '80ARC018D0010', priority: 500, source: SOURCE.research }),
  seed('nasa-compes-ii-80jsc021aa001', 'NASA', 'NASA COMPES II', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: '80JSC021AA001', priority: 500, source: SOURCE.research }),
  seed('nasa-sass-ii-80jsc025d0071', 'NASA', 'NASA SASS II', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: '80JSC025D0071', priority: 500, source: SOURCE.research }),
  seed('nasa-nehcss-80nssc23da002', 'NASA', 'NASA Enterprise-wide Human Capital Support Services', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: '80NSSC23DA002', priority: 500, source: SOURCE.research }),
  seed('va-national-dialysis-ehr-36c10a22d0003', 'VA', 'National Dialysis EHR IDIQ', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: '36C10A22D0003', priority: 500, source: SOURCE.research, notes: 'Agency-specific VA IDIQ; not a governmentwide vehicle.' }),
  seed('va-visn23-project-support-36c26324d0074', 'VA', 'VISN 23 Project Support Services IDIQ', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: '36C26324D0074', priority: 500, source: SOURCE.research, notes: 'Agency-specific VA IDIQ; not a governmentwide vehicle.' }),
  seed('army-peo-cscss-engineering-w912ch26d0017', 'Army', 'PEO CSCSS Engineering Support IDIQ', { matchMode: 'FULL_PIID', fullType: 'EXACT', full: 'W912CH26D0017', priority: 500, source: SOURCE.research, notes: 'Agency-specific single-award Army IDIQ.' }),
  ...COMPONENT_RULES.map(([id, agency, vehicle, options]) => seed(id, agency, vehicle, options)),
]

function canonicalVehicleName(value) {
  return String(value || '').trim() === 'Multiple Award Schedule' ? 'GSA MAS' : String(value || '').trim()
}

export function normalizeVehicleIdentifier(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function parseVehicleIdentifier(value) {
  const normalized = normalizeVehicleIdentifier(value)
  if (normalized.length < 13) return { normalized, legacy: true, aac: '', fiscalYear: '', instrument: '', serial: '' }
  return {
    normalized,
    legacy: false,
    aac: normalized.slice(0, 6),
    fiscalYear: normalized.slice(6, 8),
    instrument: normalized.slice(8, 9),
    serial: normalized.slice(9),
  }
}

function enabled(value) {
  return ['Y', 'YES', 'TRUE', '1', 'ENABLED'].includes(String(value || '').trim().toUpperCase())
}

function tokens(value) {
  return String(value || '').toUpperCase().split(/[\s,;~]+/).map(normalizeVehicleIdentifier).filter(Boolean)
}

function comparable(value) {
  const normalized = normalizeVehicleIdentifier(value)
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized
}

function matchesRule(value, type, rule) {
  const normalized = normalizeVehicleIdentifier(value)
  const ruleType = String(type || 'ANY').trim().toUpperCase()
  if (!RULE_TYPES.has(ruleType)) return false
  if (ruleType === 'ANY') return true
  if (ruleType === 'EXACT') return normalized === normalizeVehicleIdentifier(rule)
  if (ruleType === 'SET') return tokens(rule).includes(normalized)
  if (ruleType === 'PREFIX') return tokens(rule).some((prefix) => normalized.startsWith(prefix))
  const [from, to] = String(rule || '').split(':')
  if (!from || !to) return false
  const current = comparable(normalized)
  const minimum = comparable(from)
  const maximum = comparable(to)
  return typeof current === typeof minimum && typeof current === typeof maximum && current >= minimum && current <= maximum
}

function ruleSpecificity(rule) {
  const weights = { EXACT: 500, SET: 400, RANGE: 300, PREFIX: 200, ANY: 100 }
  if (String(rule.MATCH_MODE || '').toUpperCase() === 'FULL_PIID') {
    return 2000 + (weights[String(rule.FULL_PIID_RULE_TYPE || '').toUpperCase()] || 0)
  }
  return (weights[String(rule.SERIAL_RULE_TYPE || 'ANY').toUpperCase()] || 0) +
    Math.round((weights[String(rule.FY_RULE_TYPE || 'ANY').toUpperCase()] || 0) / 10)
}

function ruleMatches(parsed, rule) {
  if (!enabled(rule.ENABLED)) return false
  const mode = String(rule.MATCH_MODE || 'COMPONENTS').trim().toUpperCase()
  if (mode === 'FULL_PIID') return matchesRule(parsed.normalized, rule.FULL_PIID_RULE_TYPE, rule.FULL_PIID_RULE)
  return parsed.aac === normalizeVehicleIdentifier(rule.AAC) &&
    (!normalizeVehicleIdentifier(rule.INSTRUMENT_CODE) || parsed.instrument === normalizeVehicleIdentifier(rule.INSTRUMENT_CODE)) &&
    matchesRule(parsed.fiscalYear, rule.FY_RULE_TYPE, rule.FY_RULE) &&
    matchesRule(parsed.serial, rule.SERIAL_RULE_TYPE, rule.SERIAL_RULE)
}

export function resolveContractVehicle(identifier, rules = []) {
  const parsed = parseVehicleIdentifier(identifier)
  if (!parsed.normalized) return { status: 'UNRESOLVED', referencedIdvPiid: '', parsed, reason: 'No referenced IDV PIID was supplied' }
  const matches = (Array.isArray(rules) ? rules : [])
    .filter((rule) => ruleMatches(parsed, rule))
    .map((rule) => ({ rule, specificity: ruleSpecificity(rule), priority: Number(rule.PRIORITY || 0) }))
    .sort((left, right) => right.specificity - left.specificity || right.priority - left.priority || String(left.rule.RULE_ID).localeCompare(String(right.rule.RULE_ID)))
  if (!matches.length) return { status: 'UNRESOLVED', referencedIdvPiid: parsed.normalized, parsed, reason: 'No enabled workbook rule matched' }
  const best = matches[0]
  const tied = matches.filter((match) => match.specificity === best.specificity && match.priority === best.priority)
  const vehicles = new Set(tied.map((match) => `${canonicalVehicleName(match.rule.VEHICLE_NAME)}|${match.rule.VEHICLE_VARIANT || ''}`))
  if (vehicles.size > 1) {
    return {
      status: 'UNRESOLVED_CONFLICT', referencedIdvPiid: parsed.normalized, parsed,
      reason: 'Equal-strength workbook rules disagree',
      matches: tied.map(({ rule }) => ({ ruleId: rule.RULE_ID, vehicleName: rule.VEHICLE_NAME, vehicleVariant: rule.VEHICLE_VARIANT || '' })),
    }
  }
  return {
    status: 'RESOLVED', referencedIdvPiid: parsed.normalized, parsed,
    vehicleName: canonicalVehicleName(best.rule.VEHICLE_NAME),
    vehicleVariant: best.rule.VEHICLE_VARIANT || '',
    confidence: best.rule.CONFIDENCE || '',
    resolutionMethod: best.rule.MATCH_MODE === 'FULL_PIID'
      ? (['EXACT', 'SET'].includes(String(best.rule.FULL_PIID_RULE_TYPE || '').toUpperCase()) ? 'EXACT_ROSTER' : 'FULL_PIID_PATTERN')
      : 'PATTERN',
    ruleId: best.rule.RULE_ID,
    source: best.rule.SOURCE || '',
    lastVerified: best.rule.LAST_VERIFIED || '',
  }
}

export function resolveContractVehicles(identifiers, rules = []) {
  return [...new Set((identifiers || []).map(normalizeVehicleIdentifier).filter(Boolean))]
    .map((identifier) => resolveContractVehicle(identifier, rules))
}
