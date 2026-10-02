# Auth Delta — permission profiles

## ADDED Requirements

### Requirement: Permission profiles grant shared permission sets

The system SHALL let admins define per-company permission profiles and assign
one profile to a staff membership. A staff user's effective permissions SHALL be
the union of the profile permissions and the membership's individual
permissions, resolved when the session is loaded.

#### Scenario: Editing a profile updates its users

- GIVEN two staff users assigned to the "Programador" profile
- WHEN an admin adds a permission to the profile
- THEN both users have the permission on their next request

#### Scenario: Individual extra permission

- GIVEN a staff user with the "Setupista" profile
- WHEN an admin grants them `update_part_progress` individually
- THEN that user has it and other "Setupista" users do not

#### Scenario: Profile in use cannot be deleted

- GIVEN a profile assigned to at least one membership
- WHEN an admin deletes it
- THEN the request fails with a conflict

#### Scenario: Profiles are tenant-scoped

- GIVEN a profile of another company
- WHEN an admin assigns it to a membership of the active company
- THEN the request fails and the membership is unchanged

### Requirement: Default shop-floor profiles

The system SHALL seed editable "Supervisor", "Programador" and "Setupista"
profiles for a company that has none, and none of them SHALL include project
money visibility.

#### Scenario: Seeded profiles hide money

- GIVEN a company with seeded profiles
- WHEN a staff user with any seeded profile reads projects
- THEN no monetary field is returned
