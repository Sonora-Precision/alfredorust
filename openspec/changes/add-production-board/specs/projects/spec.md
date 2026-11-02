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
`take_work_orders` and the queue's permission take an unassigned step only if
it is still unassigned when written.

#### Scenario: Two programmers take the same order

- GIVEN an unassigned "Programa" step
- WHEN two programmers take it at the same time
- THEN one becomes the assignee and the other receives a conflict

#### Scenario: Filter by own assignments

- GIVEN orders assigned to Juan and to Pedro
- WHEN Juan reads the programming queue with `mine`
- THEN only Juan's orders are listed, in sequence order

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

### Requirement: Board and workload never expose money

The system SHALL return board, work order and workload data without unit
price, estimated cost, budget, PO number, quote number or invoices, for every
role.

#### Scenario: Admin reads the board

- GIVEN an admin
- WHEN they read a queue
- THEN no monetary or commercial field is present
