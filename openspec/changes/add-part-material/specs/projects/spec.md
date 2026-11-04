## ADDED Requirements

### Requirement: Each part number records its material and blank size

The system SHALL let users with `manage_production_board` record, per part
number, the material, shape, blank thickness, width and cut length in inches,
the bar to order, whether the customer supplies it and whether it was
ordered, and SHALL show a material status derived from those fields, the
received bars and the "Material habilitado" step.

#### Scenario: Admin records the material of a part

- GIVEN OT-0029 CG-15288-A with 30 pieces
- WHEN the admin records Aluminio 6061 solera, blank 0.125 x 1.75 x 5 and bar "0.125 x 1.75 x 175" as ordered
- THEN the part shows that material and the status "Pedido"

#### Scenario: Programmer cannot change the material

- GIVEN a programmer without `manage_production_board`
- WHEN they try to change the material of OT-0029
- THEN the request is rejected and the material is unchanged

### Requirement: A supplier invoice becomes a material receipt

The system SHALL create a material receipt from a CFDI of the company by its
UUID or from captured lines, SHALL read each line as a bar with material,
shape and dimensions in inches, and SHALL never store or show its prices.

#### Scenario: Invoice line read as a bar

- WHEN a receipt is created with the line "Aluminio solera 6061 de 1 1/4\" X 1 1/2\" X 125\" ( 1 pz )"
- THEN the line reads Aluminio 6061, solera, 1.25 x 1.5 x 125, 1 piece
- AND the receipt holds no price

#### Scenario: Receipt from a CFDI of another company

- GIVEN a CFDI stored for another company
- WHEN the admin creates a receipt with its UUID
- THEN the request fails with not found

### Requirement: Received bars are matched against what each part needs

The system SHALL suggest, for each receipt line, the parts whose material
matches and whose blank fits the bar section in any orientation without
exceeding any dimension by more than half of it (between 1/16 and 1/4 inch),
marked exact or larger, with the pieces it yields at a 1/16 inch cut, SHALL let
users with `manage_production_board` assign a line to one or more parts, and
SHALL report per assigned part the pieces needed against the pieces available.

#### Scenario: Exact bar suggested

- GIVEN CG-15296-A needs 30 blanks of 1 x 1.5 x 1.5 in Aluminio 6061
- WHEN a receipt has the bar Aluminio 6061 1 x 1.5 x 65
- THEN CG-15296-A is suggested as exact with 41 pieces

#### Scenario: Wider bar suggested with a note

- GIVEN CG-15288-A needs blanks of 0.125 x 1.75 x 5
- WHEN a receipt has the bar 0.125 x 2 x 144
- THEN CG-15288-A is suggested as larger with a note on the width

#### Scenario: Assigned bars cover the part

- GIVEN CG-15288-A needs 30 pieces
- WHEN the admin assigns the bars 0.125 x 2 x 144 and 0.125 x 2 x 36 to it
- THEN the part shows 35 pieces available for 30 needed
- AND its material status is "Recibido"

#### Scenario: Far bigger bar is not suggested

- GIVEN CG-15289-A needs blanks of 0.1875 x 1.5 x 5
- WHEN a receipt has the bars 1 x 1.5 x 65 and 0.25 x 1.5 x 144
- THEN only the 0.25 x 1.5 x 144 bar suggests CG-15289-A

#### Scenario: Thinner bar is not suggested

- GIVEN CG-15289-A needs blanks of 0.25 x 1.5 x 5
- WHEN a receipt has the bar 0.125 x 2 x 144
- THEN CG-15289-A is not suggested for that bar

### Requirement: The saw has a cut list per part number

The system SHALL show users who see the board, for every part of an open
project with a cut length, the material, the assigned bars with the number
of cuts and the inches left on each (a 1/16 inch cut, a shared bar used up in
assignment order), its drawing and status, and SHALL let users with
`take_work_orders` or `manage_production_board` mark the cut done, which
marks the "Material habilitado" step.

#### Scenario: Cuts per bar

- GIVEN CG-15288-A needs 30 blanks of 5 inches
- AND the bars 0.125 x 2 x 144 and 0.125 x 2 x 36 are assigned to it
- WHEN a programmer opens the cut list
- THEN it shows 28 cuts with 2.25 inches left and 2 cuts with 25.875 inches left

#### Scenario: Cut done

- WHEN a programmer marks the cut of CG-15288-A done
- THEN its "Material habilitado" step is done and its material status is "Cortado"

### Requirement: Parts are sent to the saw and the material steps tick themselves

The system SHALL let users with `take_work_orders` or
`manage_production_board` send a part with a cut length to the Sierra cinta
queue once, labelled with its cut, SHALL tick the "Material" step when a
received bar is assigned to the part, SHALL count that step as received, and
SHALL tick "Material habilitado" and clear the saw queue of the part when its
cut is marked done or the saw finishes its job.

#### Scenario: Send to cut

- GIVEN CG-15288-A needs 30 blanks of 5 inches
- WHEN a programmer sends it to cut from Seguimiento
- THEN the Sierra cinta queue holds it with the label "Corte 30 pz @ 5""
- AND sending it again fails with a conflict

#### Scenario: Received bar ticks Material

- WHEN the admin assigns a received bar to CG-15288-A
- THEN its "Material" step is done and its material status is "Recibido"

#### Scenario: Saw finishes the job

- GIVEN CG-15289-A runs on the Sierra cinta
- WHEN the operator finishes the job on the saw
- THEN its "Material habilitado" step is done and it leaves the saw queue
