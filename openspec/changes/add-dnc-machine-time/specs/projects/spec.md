# Projects Delta — measured machine time

## ADDED Requirements

### Requirement: Shop-floor machine runs are stored as intervals

The system SHALL accept machine runs (machine, program, part number, optional project code,
start, end, active minutes, cutting minutes, cycles) from an admin of the active company and
store them idempotently by source and external id within that company.

#### Scenario: Re-sending runs does not duplicate them

- GIVEN runs already ingested for a company
- WHEN the same runs are sent again
- THEN no new runs are created and only changed runs are reported as updated

#### Scenario: Staff cannot ingest

- GIVEN a staff user with `view_projects`
- WHEN they post runs
- THEN the request is forbidden

### Requirement: Machine time per part number

The system SHALL attribute each run to every part whose name equals the run's part number
(case and spaces ignored) in a project that was active when the run started (not cancelled;
delivered projects only before their completion date). When several such parts exist, the run's
minutes and cycles SHALL be split among them in proportion to the pieces each one ordered.

#### Scenario: Same part in two active projects

- GIVEN part "PIN-10" ordered 6 pieces in project A and 2 pieces in project B
- WHEN an 8-hour run of "PIN-10" is ingested
- THEN project A shows 6 hours and project B shows 2 hours for that part, marked as shared

#### Scenario: Delivered project

- GIVEN a project delivered on October 10 with part "PIN-10"
- WHEN a run of "PIN-10" starts on October 20
- THEN none of its time goes to the delivered project

#### Scenario: Tenant isolation

- GIVEN runs of company A
- WHEN a user of company B lists runs or reads a project of company A
- THEN they see no runs and the project is not found
