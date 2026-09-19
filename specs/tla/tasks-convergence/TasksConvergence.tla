--------------------------- MODULE TasksConvergence ---------------------------
(***************************************************************************)
(* Multi-device task convergence with a capture outbox — Plan 06 part B,   *)
(* docs/plans/06-offline-capture.md, and the spec docs/tasks-v1.md         *)
(* promised and never had.                                                 *)
(*                                                                         *)
(* Hand-written. polly's generator models enum and number fields behind    *)
(* HTTP handlers; it has no sets, no sequences and no second device, and   *)
(* this model is nothing but those. `bun devctl verify` runs TLC over this *)
(* file after the generated subsystems.                                    *)
(*                                                                         *)
(* The TypeScript twin is packages/api/src/specs/                          *)
(* tasks-convergence-machine.ts. Its unit test explores the same state     *)
(* space and then breaks the model five ways, one per invariant, so each   *)
(* invariant is shown able to fail. Change the two together.               *)
(*                                                                         *)
(* A task is known here only by the client id it was captured under. The   *)
(* server is a COUNT of rows per client id, not a flag: a flag could not   *)
(* hold two rows, and the idempotency invariant would be true by           *)
(* construction.                                                           *)
(*                                                                         *)
(* Not modelled: the gap between a socket's subscribe and its seed         *)
(* response (Seed is one atomic step), edits other than delete, and the    *)
(* task tree.                                                              *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Devices, ClientIds, MaxQueue

VARIABLES
  serverCount,    \* [ClientIds -> 0..2]  rows on the server bearing the id
  serverDeleted,  \* [ClientIds -> BOOLEAN]  the row is in the trash
  minted,         \* client ids already used by a capture
  outbox,         \* [Devices -> SUBSET ClientIds]  IndexedDB: survives Reload
  rows,           \* [Devices -> [ClientIds -> RowStates]]  server rows on show
  fresh,          \* [Devices -> BOOLEAN]  socket up and seeded since it opened
  queue           \* [Devices -> Seq(Events)]  broadcasts on that socket, in order

vars == <<serverCount, serverDeleted, minted, outbox, rows, fresh, queue>>

RowStates == {"absent", "live", "deleted"}
Events == [cid : ClientIds, kind : {"created", "deleted"}]

ServerView(c) ==
  IF serverCount[c] = 0 THEN "absent"
  ELSE IF serverDeleted[c] THEN "deleted" ELSE "live"

TypeOK ==
  /\ serverCount \in [ClientIds -> 0..2]
  /\ serverDeleted \in [ClientIds -> BOOLEAN]
  /\ minted \subseteq ClientIds
  /\ outbox \in [Devices -> SUBSET ClientIds]
  /\ rows \in [Devices -> [ClientIds -> RowStates]]
  /\ fresh \in [Devices -> BOOLEAN]
  /\ \A d \in Devices : queue[d] \in Seq(Events)

Init ==
  /\ serverCount = [c \in ClientIds |-> 0]
  /\ serverDeleted = [c \in ClientIds |-> FALSE]
  /\ minted = {}
  /\ outbox = [d \in Devices |-> {}]
  /\ rows = [d \in Devices |-> [c \in ClientIds |-> "absent"]]
  /\ fresh = [d \in Devices |-> FALSE]
  /\ queue = [d \in Devices |-> <<>>]

\* The server tells every socket that is up. A socket that is down hears
\* nothing, ever: the server keeps no per-client log.
Broadcast(e) ==
  [d \in Devices |-> IF fresh[d] THEN Append(queue[d], e) ELSE queue[d]]

\* Quick-add. The outbox entry is written before anything is sent, online or
\* not. A client id is a UUID: minted once, by one device.
Capture(d, c) ==
  /\ c \notin minted
  /\ minted' = minted \cup {c}
  /\ outbox' = [outbox EXCEPT ![d] = @ \cup {c}]
  /\ UNCHANGED <<serverCount, serverDeleted, rows, fresh, queue>>

\* POST /tasks with the client id. The server inserts ONLY when it holds no
\* row for that id, and only an insert is broadcast.
ServerAccepts(c) ==
  /\ serverCount' = [serverCount EXCEPT ![c] = IF @ = 0 THEN 1 ELSE @]
  /\ queue' = IF serverCount[c] = 0
                THEN Broadcast([cid |-> c, kind |-> "created"])
                ELSE queue

\* The response arrives: the entry goes, the server's row takes its place.
FlushAcked(d, c) ==
  /\ c \in outbox[d]
  /\ ServerAccepts(c)
  /\ outbox' = [outbox EXCEPT ![d] = @ \ {c}]
  /\ rows' = [rows EXCEPT ![d][c] = IF serverDeleted[c] THEN "deleted" ELSE "live"]
  /\ UNCHANGED <<serverDeleted, minted, fresh>>

\* The server commits and the response is lost. The entry stays, and will be
\* flushed again. This is the step the dedupe exists for.
FlushLost(d, c) ==
  /\ c \in outbox[d]
  /\ ServerAccepts(c)
  /\ UNCHANGED <<serverDeleted, minted, outbox, rows, fresh>>

\* A broadcast lands. One that names a client id still in this device's
\* outbox is the lost response arriving by the other road: the entry goes.
Deliver(d) ==
  /\ queue[d] /= <<>>
  /\ LET e == Head(queue[d]) IN
       /\ rows' = [rows EXCEPT ![d][e.cid] = IF e.kind = "deleted" THEN "deleted" ELSE "live"]
       /\ outbox' = [outbox EXCEPT ![d] = @ \ {e.cid}]
  /\ queue' = [queue EXCEPT ![d] = Tail(@)]
  /\ UNCHANGED <<serverCount, serverDeleted, minted, fresh>>

\* Only a row the server has confirmed can be deleted; a pending one has no
\* id to delete by.
Delete(d, c) ==
  /\ rows[d][c] = "live"
  /\ serverDeleted' = [serverDeleted EXCEPT ![c] = TRUE]
  /\ rows' = [rows EXCEPT ![d][c] = "deleted"]
  /\ queue' = Broadcast([cid |-> c, kind |-> "deleted"])
  /\ UNCHANGED <<serverCount, minted, outbox, fresh>>

\* The socket drops, or the page reloads with no network. Broadcasts on the
\* old socket are gone. The rows stay as they were — after a reload they come
\* back from the list copy — and may now be stale. The outbox is untouched.
Drop(d) ==
  /\ fresh[d]
  /\ fresh' = [fresh EXCEPT ![d] = FALSE]
  /\ queue' = [queue EXCEPT ![d] = <<>>]
  /\ UNCHANGED <<serverCount, serverDeleted, minted, outbox, rows>>

\* The socket opens and the list is fetched. A fetched row that bears the
\* client id of an outbox entry settles that entry, as Deliver does.
Seed(d) ==
  /\ ~fresh[d]
  /\ fresh' = [fresh EXCEPT ![d] = TRUE]
  /\ rows' = [rows EXCEPT ![d] = [c \in ClientIds |-> ServerView(c)]]
  /\ outbox' = [outbox EXCEPT ![d] = {c \in @ : serverCount[c] = 0}]
  /\ UNCHANGED <<serverCount, serverDeleted, minted, queue>>

Next ==
  \/ \E d \in Devices, c \in ClientIds :
       Capture(d, c) \/ FlushAcked(d, c) \/ FlushLost(d, c) \/ Delete(d, c)
  \/ \E d \in Devices : Deliver(d) \/ Drop(d) \/ Seed(d)

Spec == Init /\ [][Next]_vars

QueueBound == \A d \in Devices : Len(queue[d]) <= MaxQueue

-----------------------------------------------------------------------------
\* A client id yields at most one server row, however often it is flushed.
AtMostOneRowPerClientId == \A c \in ClientIds : serverCount[c] <= 1

\* A row on a device exists on the server; a pending entry is in the outbox
\* by construction, the outbox being what is rendered as pending.
NoPhantomTasks ==
  \A d \in Devices, c \in ClientIds : rows[d][c] /= "absent" => serverCount[c] >= 1

\* A capture is never in two places on one screen, and never in none at all.
NoDoubleDisplay ==
  \A d \in Devices, c \in ClientIds : c \in outbox[d] => rows[d][c] = "absent"
NoLostCapture ==
  \A c \in minted : serverCount[c] >= 1 \/ \E d \in Devices : c \in outbox[d]

\* Convergence, as docs/tasks-v1.md states it: a device whose socket is up and
\* has nothing left to hear shows exactly what the server holds. No lost
\* delete is the same statement read for one value, and is kept by name.
Converged ==
  \A d \in Devices :
    (fresh[d] /\ queue[d] = <<>>) => \A c \in ClientIds : rows[d][c] = ServerView(c)
NoLostDeletes ==
  \A d \in Devices, c \in ClientIds :
    (fresh[d] /\ queue[d] = <<>> /\ serverDeleted[c]) => rows[d][c] /= "live"
=============================================================================
