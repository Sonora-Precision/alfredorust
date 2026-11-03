# Projects Delta — production board

## ADDED Requirements

### Requirement: Every part number is a numbered work order

The system SHALL assign each project concept a work order number that is
sequential per company, never reused, and displayed as `OT-` followed by at
least four digits.

#### Scenario: Concurrent creation keeps numbers unique

- GIVEN a company whose last work order number is 141
- WHEN two concepts are created at the same time
- THEN they receive 142 and 143

#### Scenario: Existing concepts are numbered once

- GIVEN concepts without a work order number
- WHEN the migration runs twice
- THEN each concept gets one number in creation order and the second run changes nothing

### Requirement: Work orders appear in the queue of their current step

The system SHALL compute a work order's current step as the first active
catalog operation, by position, that has a queue and is neither done nor not
applicable for that part, and SHALL list the work order only in that step's
queue, only while its project stage is on the board and pieces remain pending.

#### Scenario: Marking the program done moves the order to setup

- GIVEN a part whose current step is "Programa" in the programming queue
- WHEN a user marks "Programa" done
- THEN the part no longer appears in the programming queue
- AND it appears in the setup queue with current step "Setup 1"

#### Scenario: Finished part leaves the board

- GIVEN a part with every queued step done or not applicable
- WHEN a user reads any queue
- THEN the part is not listed

### Requirement: Production sequence is automatic with manual pinning

The system SHALL order every queue with pinned work orders first by rank, then
the rest by effective priority (urgent, high, medium, low), then by due date
ascending with no date last, then by work order number.

#### Scenario: Pinned order stays on top

- GIVEN an urgent order due tomorrow and a low order pinned by the admin
- WHEN a user reads the queue
- THEN the pinned low order is first

#### Scenario: Dragging between two orders

- GIVEN pinned orders A and B adjacent in the queue
- WHEN an admin moves order C after A
- THEN the queue reads A, C, B

#### Scenario: Unpinning restores the automatic place

- GIVEN a pinned order
- WHEN an admin unpins it
- THEN it is listed by priority and due date again

### Requirement: Steps have an assignee and can be taken

The system SHALL store an optional assignee per part step, SHALL let users
with `manage_production_board` assign any user, and SHALL let users with
`take_work_orders` take any unassigned order for themselves, in any sequence
position and without a reason, only if it is still unassigned when written,
logging who took it.

#### Scenario: Programmer picks an order further down

- GIVEN OT-0001 and OT-0005 are unassigned and OT-0001 is first in sequence
- WHEN José Márquez takes OT-0005
- THEN OT-0005 is assigned to him and a taken event records him and the time

#### Scenario: Programmer cannot assign someone else

- GIVEN a programmer without `manage_production_board`
- WHEN they assign an order to another programmer
- THEN the request is rejected

#### Scenario: Two programmers take the same order

- GIVEN an unassigned "Programa" step
- WHEN two programmers take it at the same time
- THEN one becomes the assignee and the other receives a conflict

#### Scenario: Filter by own assignments

- GIVEN orders assigned to Juan and to Pedro
- WHEN Juan reads the programming queue with `mine`
- THEN only Juan's orders are listed, in sequence order

### Requirement: Programmers tick steps and finished pieces

The system SHALL let users with `take_work_orders` mark process steps and
record finished pieces only on parts where they hold a step (whoever manages
the board can tick any part), SHALL accept more finished pieces only when
every active step of the part is done or not applicable (counting a step
marked in the same request; lowering is always allowed), SHALL keep who and
when for every step mark and every change in finished pieces, and SHALL answer
without money for users who cannot see it.

#### Scenario: Programmer cannot tick someone else's part

- GIVEN a part where José Márquez holds no step
- WHEN he records finished pieces on it
- THEN the request is rejected

#### Scenario: Pieces need every step closed

- GIVEN a part whose "Programa" step is still pending
- WHEN anyone records more finished pieces
- THEN the request is rejected naming "Programa"
- AND recording them together with "Programa" done in the same request succeeds

#### Scenario: Programmer records pieces

- GIVEN a part of 40 pieces priced 455 by the admin
- WHEN José Márquez records 12 finished pieces and marks "Setup 1" done
- THEN the part shows 12 finished and "Setup 1" done by José Márquez
- AND the answer carries no price, cost or quoted amount
- AND a pieces event records José Márquez, +12 and the price 455

#### Scenario: Ticking does not configure the catalog

- GIVEN a programmer with `take_work_orders`
- WHEN they create or rename a process step
- THEN the request is rejected

### Requirement: Quality releases produced pieces

The system SHALL treat the pieces programmers record as produced pieces, SHALL
let users with `release_parts` (and the admin) release or reject them with a
reason for rejections, SHALL never let released plus rejected exceed produced
nor released exceed ordered, SHALL list parts waiting for quality ("En
liberación"), SHALL keep who and when, and SHALL never include money.

#### Scenario: Berenice releases and rejects

- GIVEN Carlos Dávila produced 7 pieces of OT-0002
- WHEN Berenice releases 5 and rejects 1 for "rebaba"
- THEN OT-0002 shows 5 released, 1 rejected and 1 waiting for release
- AND releasing 2 more is rejected because only 1 is waiting

#### Scenario: Programmers do not release

- GIVEN a programmer with `take_work_orders` and without `release_parts`
- WHEN they release pieces
- THEN the request is rejected

#### Scenario: Rejection needs a reason

- GIVEN quality rejects pieces without a reason
- THEN the request is rejected

### Requirement: Rejected pieces are made again

The system SHALL let produced pieces go past the pieces ordered by the rejected
ones but never below what quality already released or rejected, and SHALL let
only whoever manages the board correct released or rejected pieces downward.

#### Scenario: Remaking a rejected piece

- GIVEN a part of 10 pieces with 1 rejected
- WHEN the programmer records 11 produced
- THEN the request succeeds

#### Scenario: Quality cannot correct downward

- GIVEN Berenice without `manage_production_board`
- WHEN she sends −1 released pieces
- THEN the request is rejected

### Requirement: Everyone sees the week's finished pieces

The system SHALL count as finished only the pieces quality released, SHALL show
users with `view_production_board` the finished pieces of the current
Monday-to-Sunday week in the company time zone and of the week before, for the
whole team, for each person credited with programming each part, and per part
for the caller, and SHALL never include money.

#### Scenario: Pieces of all programmers

- GIVEN Carlos Dávila programmed OT-0002, produced 7 of its pieces this week and quality released 6
- WHEN José Márquez reads the weekly pieces
- THEN the team shows 6 and Carlos Dávila shows 6
- AND no price or amount is present

#### Scenario: Produced but not released

- GIVEN pieces produced this week that quality has not released
- WHEN anyone reads the weekly pieces
- THEN those pieces are not counted

### Requirement: Part numbers can be searched wherever orders are assigned

The system SHALL search the company's part numbers by partial part name or
folio, ignoring case, including parts no longer on the board, and SHALL return
for each its holder or none, current step or final state, queue, place in the
sequence and finished over ordered pieces, without money.

#### Scenario: Partial search finds a part off the board

- GIVEN PART-B finished every step and left the board
- WHEN a programmer searches "part-b"
- THEN PART-B is found with status "sin pasos pendientes", its last holder and its pieces

### Requirement: Weekly production report per person

The system SHALL record an append-only event for every assignment, pin and
step state change, SHALL credit a completed step to its assignee at completion
time or to the user who marked it when unassigned, and SHALL report per
credited user the work orders completed in a Monday-to-Sunday week in the
company time zone, net of reopened steps.

#### Scenario: Programs completed by each programmer

- GIVEN Juan was assigned and completed "Programa" on three parts this week
- AND Pedro marked "Programa" done on one unassigned part this week
- WHEN an admin reads this week's report for the programming queue
- THEN Juan shows 3 work orders with their folios and Pedro shows 1

#### Scenario: Reopened step is not counted

- GIVEN Juan completed "Programa" on a part and the step was reopened the same week
- WHEN an admin reads the report
- THEN that part is not counted for Juan

#### Scenario: Week boundary uses the company time zone

- GIVEN a step completed Sunday at 23:30 America/Hermosillo
- WHEN an admin reads the report
- THEN it counts in the week that ends that Sunday

#### Scenario: Staff without report permission

- GIVEN a programmer without `view_production_reports`
- WHEN they request the weekly report
- THEN the request is rejected

### Requirement: Value produced per person is admin-only

The system SHALL record every change of finished pieces with its delta and
the unit price at that moment, SHALL compute the value produced in a week as
the sum of delta times recorded price, SHALL credit it per queue to the user
credited for that work order's step in the queue, SHALL exclude parts without
a unit price, and SHALL omit every value field for non-admin users.

#### Scenario: Value counts when pieces are finished

- GIVEN Juan is credited with "Programa" on a part priced 100 with 10 pieces
- AND 6 pieces are finished this week and 4 next week
- WHEN an admin reads each week's programming report
- THEN Juan shows 600 this week and 400 next week

#### Scenario: Program released without finished pieces

- GIVEN Juan completed "Programa" this week and no pieces were finished yet
- WHEN an admin reads this week's report
- THEN the work order counts for Juan with a value produced of 0

#### Scenario: Correcting pieces down subtracts

- GIVEN 5 pieces at price 100 were recorded this week and corrected to 4
- WHEN an admin reads the report
- THEN the value produced for that part this week is 400

#### Scenario: Later price change keeps past weeks

- GIVEN pieces finished last week at price 100
- WHEN the admin changes the part price to 120
- THEN last week's value is unchanged

#### Scenario: Part without price

- GIVEN Juan completed "Programa" on a part without unit price
- WHEN an admin reads the report
- THEN the part is listed as without price and adds nothing to the value

#### Scenario: Report permission does not grant money

- GIVEN a supervisor with `view_production_reports`
- WHEN they read the weekly report
- THEN counts and work orders are present and no value field is present

### Requirement: Plant view shows machine status as a traffic light

The system SHALL show each active machine with a status of working when it
has an active machine run or a manual working state, setup when it has no
active run and its current work order has a setup step in progress or a
manual setup state, and stopped otherwise, together with the stop reason and
the time since it stopped.

#### Scenario: Machine with an active run

- GIVEN VF-3 reported a machine run 5 minutes ago that has not ended
- WHEN a user opens the plant view
- THEN VF-3 is shown as working

#### Scenario: Setup without a run

- GIVEN VF-6 has no active run
- AND its current work order has "Setup 2" pending after "Setup 1" done
- WHEN a user opens the plant view
- THEN VF-6 is shown as setup

#### Scenario: Waiting for a program

- GIVEN Mori SL-15 has no active run and no manual state
- AND its next work order has "Programa" pending
- WHEN a user opens the plant view
- THEN Mori SL-15 is shown as stopped with reason waiting for program

### Requirement: Pending orders are assigned from the plant view

The system SHALL list unassigned work orders of the programming queue in
sequence order in the plant view, SHALL let users with
`manage_production_board` assign one to any programmer, and SHALL let other
programmers only take an order for themselves.

#### Scenario: Admin drops an order on a programmer

- GIVEN OT-0155 is unassigned
- WHEN the admin assigns it to Jesús Sigala from the plant view
- THEN OT-0155 leaves the pending list and appears in Jesús Sigala's assignments
- AND an assigned event records the admin, Jesús Sigala and the time

#### Scenario: Programmer load color

- GIVEN a company load limit of 5
- AND José Márquez has 0 pending assignments, Carlos Dávila 2 and Jesús Sigala 5
- WHEN a user opens the plant view
- THEN José Márquez is shown as free, Carlos Dávila as busy and Jesús Sigala as saturated
- AND each shows their number of assigned programs

#### Scenario: Urgent order moved up in a programmer's queue

- GIVEN José Márquez has OT-0147, OT-0152 and OT-0154 assigned in that order
- AND OT-0161 arrives and is assigned to him at the bottom
- WHEN the admin moves OT-0161 above OT-0147 in his queue
- THEN his queue reads OT-0161, OT-0147, OT-0152, OT-0154
- AND OT-0161 is shown as his next order

#### Scenario: Programmer works one order at a time

- GIVEN Carlos Dávila has OT-0151 and OT-0153 assigned in that order
- WHEN he opens his start screen
- THEN only OT-0151 is shown as his next program
- AND after he marks "Programa" done on OT-0151, OT-0153 is shown

#### Scenario: Programmer reports a blocked order

- GIVEN OT-0151 is Carlos Dávila's next program
- WHEN he reports it blocked with reason "falta plano"
- THEN OT-0151 is unassigned and flagged blocked with that reason for the admin
- AND OT-0153 becomes his next program

#### Scenario: Programmer groups a similar part

- GIVEN OT-0147 is José Márquez's next program
- AND OT-0159 is unassigned, further down the sequence, with the same material and dimensions
- WHEN José takes OT-0159 related to OT-0147 with reason "mismas herramientas"
- THEN OT-0159 is assigned to José and placed right after OT-0147 in his queue
- AND the event records OT-0147 as related and the reason

#### Scenario: Grouping cannot take another programmer's order

- GIVEN OT-0159 is assigned to Carlos Dávila
- WHEN José Márquez tries to take it related to OT-0147
- THEN the request fails with a conflict and OT-0159 stays with Carlos

#### Scenario: Programmer cannot assign to someone else

- GIVEN a programmer without `manage_production_board`
- WHEN they try to assign an order to another programmer
- THEN the request is rejected and the order stays unassigned

### Requirement: Any machine can be set to a running work order by hand

The system SHALL let users with `take_work_orders` or
`manage_production_board` set, on any machine, the work order and setup it
is running, recording who and when, SHALL allow the same work order to run
on several machines at once, and SHALL show both parts with a mismatch
warning when an active DNC run reports a different part.

#### Scenario: Programmer sets what VF-3 is running

- GIVEN VF-3 has no active DNC run
- WHEN José Márquez, with `take_work_orders`, sets OT-0037 as running on VF-3
- THEN the VF-3 card shows OT-0037 in production
- AND a machine state event records José Márquez and the time

#### Scenario: Same work order running on VF-3 and VF-6

- GIVEN OT-0037 is running on VF-3 with label "Setup 1"
- WHEN the admin also sets OT-0037 "Setup 1" as running on VF-6
- THEN OT-0037 is running on both machines
- AND the card and the search say "corriendo en VF-3 (Setup 1) y VF-6 (Setup 1)"

#### Scenario: Pieces recorded per machine

- GIVEN OT-0037 runs on VF-3 and VF-6 and has 0 produced pieces
- WHEN José records 6 produced pieces from VF-3 and 4 from VF-6
- THEN OT-0037 shows 10 produced pieces and 6 from VF-3, 4 from VF-6
- AND quality releases them against the total of 10

#### Scenario: DNC reads another part

- GIVEN OT-0037 (CG-16587) is set by hand as running on VF-3
- AND the active DNC run on VF-3 reports part CG-15253-A
- WHEN a user opens the plant view
- THEN the VF-3 card shows both parts and a mismatch warning

#### Scenario: Quality cannot set the running order

- GIVEN Berenice with only `release_parts`
- WHEN she tries to set the work order running on VF-3
- THEN the request is rejected and VF-3 is unchanged

### Requirement: Each machine has an ordered queue of next work orders

The system SHALL keep an ordered queue per machine of work order entries
with a setup or operation label, allowing several entries of one work order
on the same or other machines, editable with `take_work_orders` or
`manage_production_board` and logged, SHALL show the next one and how many
wait, and SHALL offer, never do automatically, moving it to production.

#### Scenario: Next order shown on the card

- GIVEN the VF-3 queue holds OT-0040 then OT-0041
- WHEN a user opens the plant view
- THEN the VF-3 card shows "Sigue en VF-3: OT-0040" with its step and one more waiting

#### Scenario: Three setups of one order on VF-3

- GIVEN the VF-3 queue is empty
- WHEN the admin adds OT-0042 three times to VF-3 with labels "Setup 1", "Setup 2" and "Setup 3"
- THEN the VF-3 queue holds the three entries of OT-0042 in that order
- AND the search says "En fila de VF-3: Setup 2, pos. 2" for the second one

#### Scenario: Queued on another machine keeps the first

- GIVEN the machining entry of OT-0041 is in the VF-3 queue
- WHEN the admin adds the same step of OT-0041 to the VF-6 queue
- THEN OT-0041 is in both the VF-3 and the VF-6 queues

#### Scenario: Previous step not done only warns

- GIVEN OT-0042 has its cutting step pending
- WHEN a user moves its VF-3 entry to production
- THEN a soft notice says the cutting is not done
- AND OT-0042 runs on VF-3

#### Scenario: Running order ends

- GIVEN OT-0037 is running on VF-3 and OT-0040 is first in its queue
- WHEN OT-0037 reaches its ordered pieces
- THEN the card offers to move OT-0040 to production
- AND OT-0040 stays queued until the admin confirms

#### Scenario: Search shows the machine

- GIVEN OT-0041 is second in the VF-6 queue
- WHEN a user searches "OT-41"
- THEN the hit says it is in the VF-6 queue at position 2

### Requirement: Urgent work orders jump the machine queue

The system SHALL let users with `manage_production_board` mark a queued work
order urgent with a mandatory reason, placing it first in that machine
queue, marked urgent everywhere it appears, without stopping the running
order unless the admin chooses to interrupt it, in which case the
interrupted order returns to the queue right after the urgent one.

#### Scenario: Urgent order jumps the queue

- GIVEN the VF-3 queue holds OT-0040 then OT-0041
- WHEN the admin marks OT-0045 urgent on VF-3 with reason "cliente parado"
- THEN the VF-3 queue reads OT-0045, OT-0040, OT-0041
- AND OT-0045 is shown as urgent on the card, the board and the search
- AND an event records the admin and the reason

#### Scenario: Programmer cannot mark urgent

- GIVEN José Márquez with `take_work_orders` and without `manage_production_board`
- WHEN he marks OT-0045 urgent on VF-3
- THEN the request is rejected and the queue is unchanged

#### Scenario: Urgent without a reason

- WHEN the admin marks OT-0045 urgent with an empty reason
- THEN the request fails and the queue is unchanged

#### Scenario: Stop and run the urgent order

- GIVEN OT-0037 is running on VF-3 and its queue holds OT-0040
- WHEN the admin marks OT-0045 urgent on VF-3 choosing to interrupt
- THEN OT-0045 is running on VF-3
- AND the VF-3 queue reads OT-0037, OT-0040

### Requirement: Board and workload never expose money

The system SHALL return board, work order and workload data without unit
price, estimated cost, budget, PO number, quote number or invoices, for every
role.

#### Scenario: Admin reads the board

- GIVEN an admin
- WHEN they read a queue
- THEN no monetary or commercial field is present
