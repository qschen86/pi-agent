export const ledgerSchema=`
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE evidence(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,sequence TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(source_id,sequence));
CREATE TABLE scope_blocks(scope_key TEXT PRIMARY KEY,project TEXT,target TEXT NOT NULL,path TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE facts(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE fact_revisions(key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(key,revision));
CREATE TABLE candidates(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,item_index INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT,UNIQUE(request_id,item_index));
CREATE TABLE decisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,candidate_id TEXT NOT NULL REFERENCES candidates(id),project TEXT,session_id TEXT,kind TEXT NOT NULL,at TEXT NOT NULL,commit_id TEXT,state TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE attempts(seq INTEGER PRIMARY KEY AUTOINCREMENT,decision_id TEXT NOT NULL REFERENCES decisions(id),at TEXT NOT NULL);
CREATE TABLE commits(id TEXT PRIMARY KEY,state TEXT NOT NULL,payload TEXT NOT NULL,reason TEXT);
CREATE INDEX decisions_scope ON decisions(project,session_id,seq);
PRAGMA user_version=1;`;
