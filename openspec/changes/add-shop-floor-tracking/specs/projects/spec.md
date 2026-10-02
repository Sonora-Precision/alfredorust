# Projects Delta — shop-floor tracking

## ADDED Requirements

### Requirement: Project stages are tenant-defined

The system SHALL store project stages per company with name, position, color and
initial/terminal/cancelled markers, and SHALL advance a project to the next
active stage by position, skipping cancelled stages.

#### Scenario: Existing projects keep their status after migration

- GIVEN a company with projects using the legacy status enum
- WHEN the stage migration runs
- THEN the company has one stage per legacy status with the same label and order
- AND every project references the stage matching its legacy status
- AND running the migration again changes nothing

#### Scenario: Advance skips the cancelled stage

- GIVEN stages "Entrega" (4), "Cancelado" (5, cancelled) and "Cierre" (6, terminal)
- AND a project in "Entrega"
- WHEN an admin advances it
- THEN the project moves to "Cierre", not to "Cancelado"
- AND `completed_at` is set

#### Scenario: Admin sets an arbitrary stage

- GIVEN a project and a stage of the same company
- WHEN an admin sets the project stage to the cancelled stage
- THEN the project stores that stage and `completed_at`

#### Scenario: Stage from another company is rejected

- GIVEN a stage owned by another company
- WHEN an admin sets a project to that stage
- THEN the request fails with not found and the project is unchanged

### Requirement: Part progress is tracked by finished pieces

The system SHALL store finished pieces per project concept and SHALL compute
project progress as the sum of finished pieces divided by the sum of ordered
pieces, excluding concepts in a cancelled status.

#### Scenario: Progress across part numbers

- GIVEN a project with concepts of quantity 2, 2, 2, 2 and 2, 1, 0, 0 finished
- WHEN any user with project view permission reads the project
- THEN project progress is 0.375

#### Scenario: Finished pieces out of range

- GIVEN a concept with quantity 2
- WHEN a user records 3 finished pieces or a negative value
- THEN the request fails with a validation error and nothing is written

### Requirement: Progress updates are narrower than concept edits

The system SHALL let users with `update_part_progress` change only finished
pieces, concept status, material status and notes, and SHALL keep concept
create, full update and delete admin-only.

#### Scenario: Supervisor records progress

- GIVEN a staff user with `update_part_progress`
- WHEN they record finished pieces and a new status for a concept
- THEN the concept stores both values

#### Scenario: Supervisor cannot rename or reprice a part

- GIVEN a staff user with `update_part_progress`
- WHEN they call the full concept update endpoint
- THEN the request is rejected

### Requirement: Staff with project view permission can read project detail

The system SHALL let staff with `view_projects` read project concepts, concept
statuses and project stages, and SHALL omit monetary and commercial fields for
every non-admin user.

#### Scenario: Programmer opens a project

- GIVEN a staff user with `view_projects` and no money permission
- WHEN they read a project and its concepts
- THEN they receive progress, stages, quantities, due date and assignees
- AND unit price, estimated cost, budget, PO number, quote number and linked
  invoices are absent

### Requirement: Invoices link to projects without financial side effects

The system SHALL let admins link issued income CFDIs of the active company to a
project and SHALL NOT create or modify transactions or planned entries when
doing so.

#### Scenario: Link an issued invoice

- GIVEN an issued type-I CFDI of the active company
- WHEN an admin links its UUID to a project
- THEN the project lists the invoice folio, date, total and SAT status
- AND no finance record is written

#### Scenario: Reject a received or foreign invoice

- GIVEN a CFDI received by the company, or owned by another company
- WHEN an admin links it to a project
- THEN the request fails and the project is unchanged

### Requirement: Project files are versioned and permissioned by kind

The system SHALL store project and part files as logical files with immutable
versions, SHALL mark the latest version, and SHALL authorize listing, download
and upload by file kind.

#### Scenario: Programmer uploads a new program version

- GIVEN a staff user with `upload_cnc_files` and an existing CNC program file
- WHEN they upload a new version with a note
- THEN the file has a new latest version with uploader, date and note
- AND every previous version remains downloadable

#### Scenario: Setup technician cannot upload programs

- GIVEN a staff user with `view_technical_files` and without `upload_cnc_files`
- WHEN they request an upload URL for a CNC program
- THEN the request is rejected

#### Scenario: Commercial files are invisible to staff

- GIVEN a project with a purchase order file and a drawing
- WHEN a staff user with `view_technical_files` lists the project files
- THEN only the drawing is returned
- AND requesting the purchase order by id fails without revealing its existence

#### Scenario: Unconfirmed upload is not published

- GIVEN an upload URL was issued but the object was never stored
- WHEN the version is confirmed
- THEN confirmation fails and the latest version is unchanged

#### Scenario: Cross-tenant file access

- GIVEN a file of another company
- WHEN any user requests its download URL
- THEN the request fails with not found
