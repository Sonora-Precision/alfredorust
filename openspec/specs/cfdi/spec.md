# CFDI Specification

## Purpose

SAT configuration, CFDI download jobs, XML/ZIP import, CFDI-derived commitments, and optional payment creation.

## Requirements

### Requirement: SAT configs are company-scoped secrets

The system SHALL store SAT config references per company and restrict access to admins of that company.

#### Scenario: Admin creates SAT config

- GIVEN an admin for a company
- WHEN they upload valid SAT certificate files and metadata
- THEN the system stores the config for that company

#### Scenario: Unrelated admin targets SAT config

- GIVEN an admin for company A only
- WHEN they target company B SAT config
- THEN the system rejects the operation

### Requirement: CFDI download jobs are company scoped

The system SHALL associate download jobs with the company that started them and restrict job visibility to admins of that company.

#### Scenario: Job status by unrelated company

- GIVEN a job for company A
- WHEN a company B admin requests that job status
- THEN the system rejects the request

### Requirement: CFDI download jobs expose status-specific data

The system SHALL expose job status data according to the job state and clients SHALL treat the status as discriminated data.

#### Scenario: Active job omits result counters

- GIVEN a CFDI download job is queued or running
- WHEN an admin lists jobs
- THEN the job status contains the active state
- AND the client does not require imported counts, transaction counts, or errors

#### Scenario: Finished job exposes errors

- GIVEN a CFDI download job finishes with one or more SAT/import errors
- WHEN an admin lists jobs
- THEN the job status includes result counters and an errors list
- AND the UI provides a way to view each full error message, not only a count

### Requirement: CFDI download input dates are validated before SAT requests

The system SHALL reject malformed date ranges before creating SAT download jobs.

#### Scenario: Malformed date is rejected

- GIVEN an admin starts a CFDI download
- WHEN `start` or `end` is not exactly `YYYY-MM-DD`
- THEN the system returns a validation error
- AND no CFDI download job is created
- AND no SAT request is sent

#### Scenario: Inverted range is rejected

- GIVEN an admin starts a CFDI download
- WHEN `start` is after `end`
- THEN the system returns a validation error
- AND no CFDI download job is created

### Requirement: Definitive SAT rejections are not retried

The system SHALL avoid automatic retries for SAT responses that indicate the request criterion has been definitively rejected.

#### Scenario: SAT 5002 is not retried

- GIVEN a CFDI download attempt imports zero CFDIs
- AND SAT returns `5002` or `solicitud SAT rechazada`
- WHEN the job result is evaluated for retry
- THEN the system does not submit the same request again automatically

### Requirement: SAT verify waits long enough for slow responses

SAT verify/resume requests SHALL use a timeout of at least 300 seconds. The
system SHALL treat `EstadoSolicitud=2` as a successful SAT response that is
still in process, not as an HTTP failure. Only an HTTP timeout after the
configured timeout is exhausted MAY count as a failed attempt.

#### Scenario: Slow verify succeeds

- GIVEN SAT takes longer than 60 seconds to answer verify
- WHEN the response arrives before 300 seconds with `EstadoSolicitud=3`
- THEN the job proceeds to download packages
- AND the job is not failed as if SAT were down

#### Scenario: SAT says request is still processing

- GIVEN SAT verify returns `EstadoSolicitud=2`
- WHEN the job handles the response
- THEN the job keeps polling
- AND the response is logged separately from HTTP timeout errors

### Requirement: Downloaded CFDIs create commitments by default

The system SHALL create or update CFDI-backed planned entries instead of creating transactions directly by default.

#### Scenario: CFDI downloaded without automatic payments

- GIVEN a valid issued or received CFDI
- WHEN it is imported from a download job with automatic payments disabled
- THEN the system creates or updates a planned entry keyed by CFDI UUID
- AND does not create a transaction

### Requirement: Automatic CFDI payments are explicit

The system SHALL create automatic transactions only when the user explicitly enables automatic payments.

#### Scenario: CFDI downloaded with automatic payments enabled

- GIVEN a valid CFDI-backed planned entry
- WHEN automatic payments are enabled
- THEN the system creates a transaction if one does not already exist for that planned entry
