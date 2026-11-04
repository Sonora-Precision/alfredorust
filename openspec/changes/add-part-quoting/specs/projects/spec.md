## ADDED Requirements

### Requirement: Parts are quoted from the weight of their blank

The system SHALL compute, for each part of a project, the blank weight from
its blank size and material density or from a weight entered by the admin,
the material cost as weight times the company price per kg of that material,
and a suggested unit price as material cost times a multiplier (3.5 unless
set), rounded up to the peso, shown only to admins.

#### Scenario: Suggested price from the blank

- GIVEN Aluminio 6061 costs 250 per kg
- AND CG-15296-A has a blank of 1 x 1.5 x 1.5 inches in Aluminio 6061
- WHEN the admin opens the quote of the project
- THEN CG-15296-A weighs 0.0996 kg, costs 24.89 in material and is suggested at 88 with multiplier 3.5

#### Scenario: Weight from SolidWorks and another multiplier

- WHEN the admin sets 0.2 kg and multiplier 4 on CG-15296-A
- THEN its material cost is 50 and its suggested price is 200

#### Scenario: Missing price per kg

- GIVEN no price per kg for 4140
- WHEN the admin opens the quote
- THEN the 4140 parts show no suggested price and say the price per kg is missing

#### Scenario: Staff never see the quote

- WHEN a programmer requests the quote of the project
- THEN the request is rejected

### Requirement: The admin applies suggested prices

The system SHALL copy the suggested unit price of the chosen parts into their
quoted unit price only when the admin asks, leaving the others unchanged.

#### Scenario: Apply to one part

- WHEN the admin applies the suggested price of CG-15296-A
- THEN its unit price is 88 and the other parts keep theirs
