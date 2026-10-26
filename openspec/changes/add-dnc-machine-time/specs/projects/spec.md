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

The system SHALL attribute each run to the project part whose name equals the run's part
number (case and spaces ignored), restricted to the project named in the run when present,
excluding cancelled projects and preferring projects not yet delivered. Runs matching
several parts SHALL NOT be attributed to any of them.

#### Scenario: Same part in two projects

- GIVEN part "PIN-10" in projects "ZBL149 …" and "TY2157 …"
- WHEN a run for "PIN-10" names project "TY2157"
- THEN its time counts only for "TY2157"
- AND a run for "PIN-10" without project is listed as ambiguous

#### Scenario: Tenant isolation

- GIVEN runs of company A
- WHEN a user of company B lists runs or reads a project of company A
- THEN they see no runs and the project is not found
