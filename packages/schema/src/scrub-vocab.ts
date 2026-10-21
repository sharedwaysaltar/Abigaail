// The scrubber's vocabulary (DECISIONS #102): the only words an error message
// may keep. Lowercase; a word is kept when it, or every piece of an
// identifier built from it (users_email_key, findUnique), is listed here.
// Anything else becomes <word> or <value>. Common first names are left out on
// purpose, even where they are also English words. Changing this list changes
// what is sent, so it bumps SCRUB_VERSION.

const WORDS = `
a about above absent accept accepted accepting access accessed accessing account accounts acquire acquired action actions active
actual add added adding additional address addresses after again against agent aggregate alias aliases all allocate allocation allow
allowed already also alter always ambiguous amount an analyze and another any api app application apply are area arg args argument
arguments array arrays as assert assertion assign assigned async at attempt attempted attempts attribute attributes auth authenticate
authenticated authentication author authorization authorize authorized available await awaited

back backend backoff bad balance base base64 batch be because been before begin being below between big bigint binary bind
blob block blocked body bool boolean both bound bounds broken browser buffer bug build built bulk busy but by byte bytes

cache cached call callback called calling calls can can't cancel canceled cancelled cannot capacity card cards case cast catch
category cause caused certificate chain change changed changes channel char character characters charge charges check checked
checkout child choice chunk circular class clause clean clear client clients close closed closing cluster code codes collation
collection collections column columns com command commands comment comments commit committed common compare compile compiled
complete completed component compose condition config configuration conflict connect connected connecting connection connections
connector consider constraint constraints construct constructor consumer contain contained contains content context continue
control controller conversion convert cookie copy core correct cors could count counter country create created creating creation
credential credentials cross crypto csv currency current cursor custom customer customers cycle cyclic

daemon data database databases date datetime day days db deadlock deadline debug decimal decline declined decode decoding decrypt
default defined definition delete deleted denied dependency deprecated depth deserialize destination detail details detected device
did didn't digest dimension dir direction directory disabled disconnect disconnected disk dispatch display distinct do document
documents does doesn't domain don't done double down driver drop dropped dup duplicate duration during dynamic

each early econn edge element elements else email emails empty enable enabled encode encoded encoding encrypt end ended endpoint
enforce engine enough ensure entity entries entry enum env environment eof equal err error errors event events exceed exceeded
exceeds exception exceptions exclusive exec execute executed execution exist existing exists exit expect expected expiration expire
expired expires expiry explicit export expression extension external extra

factor fail failed failing fails failure false fatal feature fetch fetched fetching field fields file files filter final find first
fix flag float flush folder following for forbidden foreign form format found frame free from full function functions

gateway generate generated get getaddrinfo given global go got grant granted graph group groups guard

had handle handler handshake has hash have header headers heap here hex hidden high history hook host hostname hosts hour hours
how http https

id identifier identity ids if illegal image implement implemented import in incompatible incomplete incorrect increment index
indexes infinite info information init initial initialize initialized inner input insert inserted insufficient instance int integer
integrity interface internal interval into invalid invocation is isn't issue issued issuer it item items iterable iterator its

job join json jwt key keys kind

label language large last latency later layer lazy leak least left length level library limit limited line lines link list
listen listener literal load loaded loading local locale lock locked log logged login logout long lookup loop lost low

machine main malformed manager many map mapping match matched matches max maximum may memory merge message messages meta
metadata method methods middleware migration migrations millisecond milliseconds min minimum minute minutes miss missing mode model
models module modules money mongo mongodb mongoose month more most move multiple must mutation mysql

name named names namespace native need needed negative nest nested network new next no node non none not note notfound nothing
notification now null nullable number numeric

object objects of off offset ok old on once one only open opened operation operations operator option optional options or order
orders origin other out outside over overflow overload owner

package packet page pages param parameter parameters params parent parse parsed parser parsing part partial partition pass passed
password path pattern payload payment payments peer pending per permission permissions phone pipe pk plan please plugin pointer
policy pool port position positive possible post posts postgres postgresql precision prefix prepare prepared price primary prisma
private process processed processing product products profile promise properties property protocol provide provided provider proxy
public publish push

queries query queue quota quote

range rate raw reach reached read reading ready real reason receive received record records recursion recursive redirect redis
reduce reference referenced references refresh refused region register registered registry reject rejected relation relations
release remote remove removed render rendered repeat replace replica reply report request requested requests require required
requires reserved reset resolve resolved resource resources response responses result results retry retrying return returned
returns revoked right role roles rollback root route router routes row rows rule rules run running runtime

safe same save saved scalar schema scope scopes search second seconds secret secure select selected send sent sequence serial
serialize server service session sessions set setting settings setup shape shared should shutdown sign signal signature signed
size skip slow small socket some something sort source space spec specified sql ssl stack start started state statement static
status step stock storage store stored stream strict string strings stripe structure subject subscription success such supplied
support supported sync syntax system

table tables target task tcp template temporary terminated test text than that the their them then there these they this thread
throw thrown time timed timeout timer timestamp tls to too token tokens total trace transaction transactions transform true
truncate try trying tsx type types

udp unable unauthorized undefined under undici unexpected unhandled union unique unit unknown unreachable unsupported until up
update updated upload upsert uri url usage use used user username users using utf utf8 uuid

valid validate validation value values var variable variables verify version via view violates violation void

wait waiting want warning was wasn't we were what when where which while with within without won't worker workers wrap write
writing written wrong

xml yes yet you your

zero zone

bearer basic iban hang buffering unexpectedly retries retried refer instead hello cancelled replaced
assignment constant destructure attached funds passing matching signatures depends aborted remaining slots superuser
replication audience manual corresponds near javascript string int integer side abort aborting missing reached
received unknown expected got instead cast objectid wrongtype forbidden unprocessable gateway unavailable bad
timeouterror typeerror rangeerror syntaxerror referenceerror evalerror urierror aggregateerror
about pricing blog contact signup signin register dashboard cart checkout docs doc search admin home faq terms privacy help
support news careers jobs team teams settings profile orders billing invoices invoice plans features feed rss sitemap
graphql trpc webhooks webhook callbacks oauth sso health healthz status metrics ping well known assets static public images
img js css fonts media downloads download share embed preview edit new show list detail details category categories tags tag
archive archives press legal cookies security integrations partners customers pricing changelog roadmap demo landing
chat chats message messages conversation conversations upload uploads

js ts jsx mjs cjs html css md txt yaml yml toml sh lib src dist test tests spec specs util utils helper helpers api app apps
components component pages page layout route handler handlers server client index main config hooks hook types middleware
dto entity entities service services repository repositories controller controllers model models schema schemas migration
v1 v2 v3 econnrefused econnreset etimedout enotfound epipe eacces eaddrinuse
ecdsa hmac rsa sha sha1 sha256 sha512 md5 base64url aes gcm cbc pem x509 ca cert certs
`;

export const VOCABULARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));

/**
 * Vocabulary words that are also common first names. Capitalised in the
 * middle of a sentence they are treated as names (<word>); a test keeps every
 * other vocabulary word off a list of common first names.
 */
export const NAME_LIKE: ReadonlySet<string> = new Set(["may", "max", "grant", "art", "will", "mark", "chase", "summer", "ray", "pat", "hope", "joy"]);
