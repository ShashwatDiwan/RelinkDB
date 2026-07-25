const fs = require("fs");
const path = require("path");
const { splitStatements, expandCopyBlocks } = require("./lib/sql-runner");

const sql = fs.readFileSync(path.join(__dirname, "data.sql"), "utf8");
const expanded = expandCopyBlocks(sql);
const stmts = splitStatements(sql);
const insertCount = (expanded.match(/INSERT INTO/gi) || []).length;
const copyRemaining = (expanded.match(/COPY\s+.+\s+FROM\s+stdin/gi) || []).length;

console.log("data.sql:");
console.log("  statements:", stmts.length);
console.log("  inserts after expand:", insertCount);
console.log("  unreplaced COPY blocks:", copyRemaining);

const neonLike = `CREATE TABLE public.sheet (sheet_id integer, sheet_name varchar(255));
COPY public.sheet (sheet_id, sheet_name) FROM stdin;
1\tTest Sheet
2\tAnother
\\.`;
const exp2 = expandCopyBlocks(neonLike);
console.log("neon-like inserts:", (exp2.match(/INSERT INTO/gi) || []).length);
console.log("expanded sample:", exp2.trim().split("\n").slice(-2).join("\n"));
