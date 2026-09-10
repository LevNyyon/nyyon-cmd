// Derive country and state/region from a phone number by its FORMAT only (no
// network call). For +1 (NANP) we map the area code to a US state, Canadian
// province, or Caribbean country. Otherwise we map the calling code to a country.
// ponytail: static reference tables (NANP area codes + ITU calling codes). Stable
// data; if an operator needs to correct one, move these into a knowledge note later.

const ST = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',
  LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',
  NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
  OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

// US area code -> state abbreviation
const US = {
  '205':'AL','251':'AL','256':'AL','334':'AL','659':'AL','938':'AL','907':'AK',
  '480':'AZ','520':'AZ','602':'AZ','623':'AZ','928':'AZ','479':'AR','501':'AR','870':'AR',
  '209':'CA','213':'CA','279':'CA','310':'CA','323':'CA','341':'CA','350':'CA','408':'CA','415':'CA','424':'CA','442':'CA','510':'CA','530':'CA','559':'CA','562':'CA','619':'CA','626':'CA','628':'CA','650':'CA','657':'CA','661':'CA','669':'CA','707':'CA','714':'CA','747':'CA','760':'CA','805':'CA','818':'CA','820':'CA','831':'CA','840':'CA','858':'CA','909':'CA','916':'CA','925':'CA','949':'CA','951':'CA',
  '303':'CO','719':'CO','720':'CO','970':'CO','983':'CO','203':'CT','475':'CT','860':'CT','959':'CT',
  '302':'DE','202':'DC',
  '239':'FL','305':'FL','321':'FL','352':'FL','386':'FL','407':'FL','561':'FL','656':'FL','689':'FL','727':'FL','754':'FL','772':'FL','786':'FL','813':'FL','850':'FL','863':'FL','904':'FL','941':'FL','954':'FL',
  '229':'GA','404':'GA','470':'GA','478':'GA','678':'GA','706':'GA','762':'GA','770':'GA','912':'GA','943':'GA','808':'HI','208':'ID','986':'ID',
  '217':'IL','224':'IL','309':'IL','312':'IL','331':'IL','447':'IL','464':'IL','618':'IL','630':'IL','708':'IL','730':'IL','773':'IL','779':'IL','815':'IL','847':'IL','872':'IL',
  '219':'IN','260':'IN','317':'IN','463':'IN','574':'IN','765':'IN','812':'IN','930':'IN',
  '319':'IA','515':'IA','563':'IA','641':'IA','712':'IA','316':'KS','620':'KS','785':'KS','913':'KS',
  '270':'KY','364':'KY','502':'KY','606':'KY','859':'KY','225':'LA','318':'LA','337':'LA','504':'LA','985':'LA','207':'ME',
  '240':'MD','301':'MD','410':'MD','443':'MD','667':'MD',
  '339':'MA','351':'MA','413':'MA','508':'MA','617':'MA','774':'MA','781':'MA','857':'MA','978':'MA',
  '231':'MI','248':'MI','269':'MI','313':'MI','517':'MI','586':'MI','616':'MI','679':'MI','734':'MI','810':'MI','906':'MI','947':'MI','989':'MI',
  '218':'MN','320':'MN','507':'MN','612':'MN','651':'MN','763':'MN','952':'MN','228':'MS','601':'MS','662':'MS','769':'MS',
  '314':'MO','417':'MO','557':'MO','573':'MO','636':'MO','660':'MO','816':'MO','406':'MT','308':'NE','402':'NE','531':'NE',
  '702':'NV','725':'NV','775':'NV','603':'NH',
  '201':'NJ','551':'NJ','609':'NJ','640':'NJ','732':'NJ','848':'NJ','856':'NJ','862':'NJ','908':'NJ','973':'NJ','505':'NM','575':'NM',
  '212':'NY','315':'NY','332':'NY','347':'NY','363':'NY','516':'NY','518':'NY','585':'NY','607':'NY','631':'NY','646':'NY','680':'NY','716':'NY','718':'NY','838':'NY','845':'NY','914':'NY','917':'NY','929':'NY','934':'NY',
  '252':'NC','336':'NC','472':'NC','704':'NC','743':'NC','828':'NC','910':'NC','919':'NC','980':'NC','984':'NC','701':'ND',
  '216':'OH','220':'OH','234':'OH','283':'OH','326':'OH','330':'OH','380':'OH','419':'OH','440':'OH','513':'OH','567':'OH','614':'OH','740':'OH','937':'OH',
  '405':'OK','539':'OK','572':'OK','580':'OK','918':'OK','458':'OR','503':'OR','541':'OR','971':'OR',
  '215':'PA','223':'PA','267':'PA','272':'PA','412':'PA','445':'PA','484':'PA','570':'PA','582':'PA','610':'PA','717':'PA','724':'PA','814':'PA','835':'PA','878':'PA','401':'RI',
  '803':'SC','839':'SC','843':'SC','854':'SC','864':'SC','605':'SD','423':'TN','615':'TN','629':'TN','731':'TN','865':'TN','901':'TN','931':'TN',
  '210':'TX','214':'TX','254':'TX','281':'TX','325':'TX','346':'TX','361':'TX','409':'TX','430':'TX','432':'TX','469':'TX','512':'TX','682':'TX','713':'TX','726':'TX','737':'TX','806':'TX','817':'TX','830':'TX','832':'TX','903':'TX','915':'TX','936':'TX','940':'TX','945':'TX','956':'TX','972':'TX','979':'TX',
  '385':'UT','435':'UT','801':'UT','802':'VT',
  '276':'VA','434':'VA','540':'VA','571':'VA','686':'VA','703':'VA','757':'VA','804':'VA','826':'VA','948':'VA',
  '206':'WA','253':'WA','360':'WA','425':'WA','509':'WA','564':'WA','304':'WV','681':'WV',
  '262':'WI','274':'WI','414':'WI','534':'WI','608':'WI','715':'WI','920':'WI','307':'WY',
};

// US territories (country = United States)
const USTERR = { '787':'Puerto Rico','939':'Puerto Rico','671':'Guam','340':'U.S. Virgin Islands','684':'American Samoa','670':'Northern Mariana Islands' };

// Canadian area code -> province/territory (country = Canada)
const CA = {
  '403':'Alberta','587':'Alberta','780':'Alberta','825':'Alberta','368':'Alberta',
  '236':'British Columbia','250':'British Columbia','604':'British Columbia','672':'British Columbia','778':'British Columbia','257':'British Columbia',
  '204':'Manitoba','431':'Manitoba','584':'Manitoba','506':'New Brunswick','709':'Newfoundland and Labrador','879':'Newfoundland and Labrador',
  '782':'Nova Scotia','902':'Nova Scotia','867':'Northern Canada',
  '226':'Ontario','249':'Ontario','343':'Ontario','365':'Ontario','382':'Ontario','416':'Ontario','437':'Ontario','519':'Ontario','548':'Ontario','613':'Ontario','647':'Ontario','683':'Ontario','705':'Ontario','742':'Ontario','753':'Ontario','807':'Ontario','905':'Ontario',
  '367':'Quebec','418':'Quebec','438':'Quebec','450':'Quebec','514':'Quebec','579':'Quebec','581':'Quebec','819':'Quebec','873':'Quebec','263':'Quebec','354':'Quebec',
  '306':'Saskatchewan','639':'Saskatchewan','474':'Saskatchewan',
};

// Other NANP (+1) countries -> country, no region
const CARIB = {
  '242':'Bahamas','246':'Barbados','264':'Anguilla','268':'Antigua and Barbuda','284':'British Virgin Islands','345':'Cayman Islands','441':'Bermuda','473':'Grenada','649':'Turks and Caicos','658':'Jamaica','664':'Montserrat','721':'Sint Maarten','758':'Saint Lucia','767':'Dominica','784':'Saint Vincent and the Grenadines','809':'Dominican Republic','829':'Dominican Republic','849':'Dominican Republic','868':'Trinidad and Tobago','869':'Saint Kitts and Nevis','876':'Jamaica',
};

// ITU country calling codes -> country (non-NANP). Longest-prefix matched.
const CALLING = {
  '1':'United States/Canada','7':'Russia','20':'Egypt','27':'South Africa','30':'Greece','31':'Netherlands','32':'Belgium','33':'France','34':'Spain','36':'Hungary','39':'Italy','40':'Romania','41':'Switzerland','43':'Austria','44':'United Kingdom','45':'Denmark','46':'Sweden','47':'Norway','48':'Poland','49':'Germany',
  '51':'Peru','52':'Mexico','53':'Cuba','54':'Argentina','55':'Brazil','56':'Chile','57':'Colombia','58':'Venezuela','60':'Malaysia','61':'Australia','62':'Indonesia','63':'Philippines','64':'New Zealand','65':'Singapore','66':'Thailand',
  '81':'Japan','82':'South Korea','84':'Vietnam','86':'China','90':'Turkey','91':'India','92':'Pakistan','93':'Afghanistan','94':'Sri Lanka','95':'Myanmar','98':'Iran',
  '212':'Morocco','213':'Algeria','216':'Tunisia','218':'Libya','220':'Gambia','221':'Senegal','233':'Ghana','234':'Nigeria','251':'Ethiopia','254':'Kenya','255':'Tanzania','256':'Uganda','260':'Zambia','263':'Zimbabwe',
  '350':'Gibraltar','351':'Portugal','352':'Luxembourg','353':'Ireland','354':'Iceland','355':'Albania','356':'Malta','357':'Cyprus','358':'Finland','359':'Bulgaria','370':'Lithuania','371':'Latvia','372':'Estonia','373':'Moldova','374':'Armenia','375':'Belarus','376':'Andorra','377':'Monaco','378':'San Marino','380':'Ukraine','381':'Serbia','382':'Montenegro','383':'Kosovo','385':'Croatia','386':'Slovenia','387':'Bosnia and Herzegovina','389':'North Macedonia',
  '420':'Czech Republic','421':'Slovakia','423':'Liechtenstein',
  '852':'Hong Kong','853':'Macau','855':'Cambodia','856':'Laos','880':'Bangladesh','886':'Taiwan',
  '960':'Maldives','961':'Lebanon','962':'Jordan','963':'Syria','964':'Iraq','965':'Kuwait','966':'Saudi Arabia','967':'Yemen','968':'Oman','970':'Palestine','971':'United Arab Emirates','972':'Israel','973':'Bahrain','974':'Qatar','975':'Bhutan','976':'Mongolia','977':'Nepal','992':'Tajikistan','993':'Turkmenistan','994':'Azerbaijan','995':'Georgia','996':'Kyrgyzstan','998':'Uzbekistan',
};

function nanp(area) {
  if (US[area]) return { country: 'United States', region: ST[US[area]], area_code: area };
  if (USTERR[area]) return { country: 'United States', region: USTERR[area], area_code: area };
  if (CA[area]) return { country: 'Canada', region: CA[area], area_code: area };
  if (CARIB[area]) return { country: CARIB[area], region: null, area_code: area };
  return { country: null, region: null, area_code: area };
}

export function locatePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return { country: null, region: null, area_code: null };
  if (digits.length === 11 && digits[0] === '1') return nanp(digits.slice(1, 4));
  if (digits.length === 10) return nanp(digits.slice(0, 3)); // NANP without country code
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (CALLING[code]) return { country: CALLING[code], region: null, area_code: null };
  }
  return { country: null, region: null, area_code: null };
}

// Calling code -> ISO2 country, for building Truecaller search URLs.
const CC_ISO = {
  '1':'us','7':'ru','20':'eg','27':'za','30':'gr','31':'nl','32':'be','33':'fr','34':'es','36':'hu','39':'it','40':'ro','41':'ch','43':'at','44':'gb','45':'dk','46':'se','47':'no','48':'pl','49':'de',
  '51':'pe','52':'mx','53':'cu','54':'ar','55':'br','56':'cl','57':'co','58':'ve','60':'my','61':'au','62':'id','63':'ph','64':'nz','65':'sg','66':'th','81':'jp','82':'kr','84':'vn','86':'cn','90':'tr','91':'in','92':'pk','93':'af','94':'lk','95':'mm','98':'ir',
  '212':'ma','213':'dz','216':'tn','218':'ly','220':'gm','221':'sn','233':'gh','234':'ng','251':'et','254':'ke','255':'tz','256':'ug','260':'zm','263':'zw',
  '350':'gi','351':'pt','352':'lu','353':'ie','354':'is','355':'al','356':'mt','357':'cy','358':'fi','359':'bg','370':'lt','371':'lv','372':'ee','373':'md','374':'am','375':'by','376':'ad','377':'mc','378':'sm','380':'ua','381':'rs','382':'me','383':'xk','385':'hr','386':'si','387':'ba','389':'mk','420':'cz','421':'sk','423':'li',
  '852':'hk','853':'mo','855':'kh','856':'la','880':'bd','886':'tw','960':'mv','961':'lb','962':'jo','963':'sy','964':'iq','965':'kw','966':'sa','967':'ye','968':'om','970':'ps','971':'ae','972':'il','973':'bh','974':'qa','975':'bt','976':'mn','977':'np','992':'tj','993':'tm','994':'az','995':'ge','996':'kg','998':'uz',
};

// Best-effort outward link to a Truecaller search for a number. The operator has
// their own Truecaller login; this just lands them on the right search.
export function truecallerUrl(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits[0] === '1') {
    const iso = CA[digits.slice(1, 4)] ? 'ca' : 'us';
    return `https://www.truecaller.com/search/${iso}/${digits.slice(1)}`;
  }
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (CC_ISO[code]) return `https://www.truecaller.com/search/${CC_ISO[code]}/${digits.slice(len)}`;
  }
  return `https://www.truecaller.com/search/us/${digits}`;
}

// ── ported from gtm-blackbox tools: normalize_phone + parse_phone_list ──────
// (pure — no knowledge-note lookup; default country code is a plain arg)

// Normalize one number to E.164 and flag validity.
export function normalizePhone(number, defaultCC = '+972') {
  const raw = String(number || '');
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = defaultCC + d.replace(/\D/g, '').replace(/^0+/, '');
  const valid = /^\+\d{8,15}$/.test(d);
  return { normalized: valid ? d : raw, valid };
}

// Parse pasted text (one per line, or a CSV with a phone column) into candidates.
export function parsePhoneList(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let idx = 0;
  if (/[a-z]/i.test(lines[0]) && lines[0].includes(',')) {
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    idx = Math.max(0, headers.indexOf('phone'));
    lines.shift();
  }
  return lines
    .map((l) => (l.includes(',') ? l.split(',')[idx] : l).trim())
    .filter((p) => /\d/.test(p));
}
