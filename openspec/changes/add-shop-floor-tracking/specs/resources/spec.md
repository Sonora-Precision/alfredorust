# Resources Delta — machine hours

## ADDED Requirements

### Requirement: Empty allowed statuses means every status

The system SHALL offer a resource in the hourly grid for every concept status
when its allowed-status list is empty.

#### Scenario: New machine without restrictions

- GIVEN an active resource with no allowed statuses
- WHEN a user with grid permission opens the hourly grid
- THEN the resource is available for concepts in any non-terminal status

### Requirement: Real cost per part and project is admin-only

The system SHALL compute real machine cost per concept and per project from
resource usage allocations and SHALL return it only to admins.

#### Scenario: Supervisor records hours without seeing cost

- GIVEN a supervisor with `edit_resource_usage_today`
- WHEN they save machine hours for today and read the project
- THEN the hours are stored
- AND no cost value is returned to them
