// Re-run the DBLP abbreviation battery after COMMON_ABBREVIATIONS expansion.
const lib = require('../GSVR/tests/accuracy_benchmark_lib.js');

// [query, expected matchedTitle (identity check), expected quartile 2023]
const cases = [
  ['IEEE Trans. Mob. Comput.', 'IEEE Transactions on Mobile Computing'],
  ['IEEE J. Sel. Areas Commun.', 'IEEE Journal on Selected Areas in Communications'],
  ['ACM Trans. Sens. Networks', 'ACM Transactions on Sensor Networks'],
  ['IEEE Trans. Ind. Informatics', 'IEEE Transactions on Industrial Informatics'],
  ['IEEE Commun. Surv. Tutorials', 'IEEE Communications Surveys and Tutorials'],
  ['J. Mach. Learn. Res.', 'Journal of Machine Learning Research'],
  ['IEEE Trans. Parallel Distributed Syst.', 'IEEE Transactions on Parallel and Distributed Systems'],
  ['Future Gener. Comput. Syst.', 'Future Generation Computer Systems'],
  ['Pervasive Mob. Comput.', 'Pervasive and Mobile Computing'],
  ['Ad Hoc Networks', 'Ad Hoc Networks'],
  ['Comput. Networks', 'Computer Networks'],
  ['IEEE Wirel. Commun.', 'IEEE Wireless Communications'],
  ['IEEE Netw.', 'IEEE Network'],
  ['Sensors', 'Sensors'],
  ['IEEE Access', 'IEEE Access'],
  ['PLoS ONE', 'PLOS ONE'],
  ['Nature', 'Nature'],
  ['Science', 'Science'],
  ['Expert Syst. Appl.', 'Expert Systems with Applications'],
  ['Knowl. Based Syst.', 'Knowledge-Based Systems'],
  ['Inf. Sci.', 'Information Sciences'],
  ['Appl. Soft Comput.', 'Applied Soft Computing'],
  ['Neural Comput. Appl.', 'Neural Computing and Applications'],
  ['IEEE Trans. Veh. Technol.', 'IEEE Transactions on Vehicular Technology'],
  ['IEEE Internet Comput.', 'IEEE Internet Computing'],
  ['Concurr. Comput. Pract. Exp.', 'Concurrency and Computation: Practice and Experience'],
  ['Softw. Pract. Exp.', 'Software - Practice and Experience'],
  ['Empir. Softw. Eng.', 'Empirical Software Engineering'],
  ['Autom. Softw. Eng.', 'Automated Software Engineering'],
  ['Real Time Syst.', 'Real-Time Systems'],
  ['IEEE Trans. Computers', 'IEEE Transactions on Computers'],
  ['IEEE Trans. Software Eng.', 'IEEE Transactions on Software Engineering'],
  ['ACM Trans. Database Syst.', 'ACM Transactions on Database Systems'],
  ['IEEE Trans. Knowl. Data Eng.', 'IEEE Transactions on Knowledge and Data Engineering'],
  ['IEEE Trans. Pattern Anal. Mach. Intell.', 'IEEE Transactions on Pattern Analysis and Machine Intelligence'],
  ['Artif. Intell.', 'Artificial Intelligence'],
  ['J. Netw. Comput. Appl.', 'Journal of Network and Computer Applications'],
  ['IEEE Trans. Inf. Theory', 'IEEE Transactions on Information Theory'],
  ['IEEE/ACM Trans. Netw.', 'IEEE/ACM Transactions on Networking'],
  ['Computing', 'Computing'],
  ['ACM Trans. Graph.', null],
  ['ACM Trans. Softw. Eng. Methodol.', 'ACM Transactions on Software Engineering and Methodology'],
  ['IEEE Trans. Dependable Secur. Comput.', 'IEEE Transactions on Dependable and Secure Computing'],
  ['ACM Comput. Surv.', 'ACM Computing Surveys'],
  ['J. Cogn. Neurosci.', 'Journal of Cognitive Neuroscience'],
  ['Oper. Syst. Rev.', null],
  ['IEEE Trans. Ind. Electron.', 'IEEE Transactions on Industrial Electronics'],
  ['Inf. Process. Lett.', 'Information Processing Letters'],
];

let matched = 0; let missing = 0; let ambiguous = 0; let wrongIdentity = 0;
for (const [name, expectedTitle] of cases) {
  const r = lib.resolveJournalQuerySync(name, 2023, {});
  const tag = r.status === 'matched' ? 'MATCH ' : (r.status === 'ambiguous' ? 'AMBIG ' : 'MISS  ');
  if (r.status === 'matched') matched++;
  else if (r.status === 'ambiguous') ambiguous++;
  else missing++;
  let note = '';
  if (r.status === 'matched' && expectedTitle && r.matchedTitle.toLowerCase() !== expectedTitle.toLowerCase()) {
    wrongIdentity++;
    note = ` <-- WRONG IDENTITY (expected ${expectedTitle})`;
  }
  console.log(`${tag} ${name.padEnd(42)} -> ${String(r.quartile).padEnd(4)} ${String(r.matchedTitle || '').slice(0, 56)} [${r.matchType || '-'}]${note}`);
}
console.log(`\nmatched=${matched} ambiguous=${ambiguous} missing=${missing} wrongIdentity=${wrongIdentity} of ${cases.length}`);
process.exitCode = wrongIdentity > 0 ? 1 : 0;
