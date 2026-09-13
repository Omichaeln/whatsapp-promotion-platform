# The promotion desk (the client's console)

There are two consoles on the same URL. Which one a person sees is decided by the
roles on their account, not by a setting they can lose.

| Console | Who it is for | What it shows |
|---|---|---|
| Promotion desk | The client's promotion administrator and their assistants | Today, Entries, Submissions, Queries — in plain language, no codes |
| Technical console | The platform team | Everything: campaigns, versions, draws, winners, audit chain, integrations, staff |

A person holding a promotion role sees the promotion desk. If they also hold a
technical role (a platform engineer sitting with the client, say) a **Technical
view** button appears; nobody else gets one.

## Creating the client's accounts

Two roles, and the difference between them is one thing: an assistant cannot
change an entry's standing.

| Role | Reads everything on the desk | Answers participant queries | Disqualifies or reinstates an entry |
|---|---|---|---|
| `promotion_admin` | yes | yes | yes |
| `promotion_assistant` | yes | yes | **no** |

Create them from the technical console (Access → Add staff) or over the API:

```
POST /api/users   { "email": "…", "name": "…", "roles": ["promotion_admin"] }
POST /api/users   { "email": "…", "name": "…", "roles": ["promotion_assistant"] }
```

The account is created with a temporary password that must be changed on first
sign-in. Give the promotion administrator role to one or two people, not to
everyone: it is the role that can take a shopper's entry away.

Deliberately **not** granted to either role: the draw machinery, winner
handling, staff administration, the audit chain, integrations, rules and version
editing, and anything that can unmask a national identity number. Those stay with
the platform team. The campaign list is readable, as it is by any signed-in user.

## The four screens

**Today** answers one question: is anything waiting? Two tiles are buttons,
because two are jobs. One of them is not yet yours: the receipts waiting on a
decision are shown to you, but deciding them is a reviewer action that sits with
the platform team today. If your team should be deciding its own borderline
receipts, say so — it is a deliberate choice, not an oversight, and it is a small
change to make.

**Entries** is every entry that has been earned. One entry is one purchase that
met the rules. Each row names the person, the shop and branch, the town, how many
packs they bought, and how many receipts that person has sent in altogether.

**Submissions** is every receipt that was sent in, whatever happened to it. This
is the screen that answers "why did this one not count?" — an entry only exists
for the receipts that qualified, so a list of entries can never explain the rest.
The chips across the top are the categories: earned an entry, needs a look, did
not qualify, already claimed, photo unreadable, still being read.

**Queries** is the people who asked for a human. While a query is open the
automatic replies stop for that person, so each one needs an answer and then
handing back. The list is the point: the technical console makes you type a phone
number, which only works if you already know who is waiting.

## The filters

Every filter works on both Entries and Submissions, and they combine.

| Filter | What it means |
|---|---|
| Period | The promotion week |
| Shop | The retailer, e.g. every Sunrise branch |
| Branch | One specific shop |
| Town, Province | Where the purchase was made |
| Packs bought | The quantity of the qualifying product on that receipt, as a range |
| Receipts sent by that person | How many receipts that person has sent to this promotion, as a range |
| Outcome | Submissions only: which category |
| Name or number | Free-text search over the person |

Two notes on reading them honestly.

**"Packs bought" is what the rules counted, not what was printed.** It comes from
the decision the participant was actually given, recorded on the receipt at the
moment it was decided. Where the photo could not be read the column says "not
read" rather than 0 — "we could not tell" and "they bought none" are different
statements, and a filter of "at least 1 pack" excludes both.

**"Receipts sent by that person" counts every receipt they sent to this
promotion**, including the ones that did not qualify. It is the number you want
when a name keeps appearing: a high count with few entries is worth a look.

## Deciding an entry

Only the promotion administrator sees the Disqualify and Put back buttons. Both
ask for a reason, and the reason is not optional — it is written into the
tamper-evident audit trail with your name and shown to auditors.

If the entry is already in a draw that has been locked, the system will ask for a
second person's approval before it will act. That is not a bug to work around: it
is what stops one person quietly changing the outcome of a draw after seeing it.
The same applies to putting an entry back that was removed under approval.

## What this console cannot do

It cannot run a draw, pick or publish a winner, change the rules, edit the
promotion's dates or content, add staff, or read a national identity number.
Those need the platform team. Ask, rather than looking for a way round it — most
of them are dual-controlled and will refuse a single person anyway.
