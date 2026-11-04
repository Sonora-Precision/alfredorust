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
matches and whose blank fits the bar section in any orientation, marked exact
or larger, with how many pieces the bar yields at a 1/16 inch cut, SHALL let
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

#### Scenario: Thinner bar is not suggested

- GIVEN CG-15289-A needs blanks of 0.25 x 1.5 x 5
- WHEN a receipt has the bar 0.125 x 2 x 144
- THEN CG-15289-A is not suggested for that bar
