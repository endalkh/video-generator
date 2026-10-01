/** Domain errors carry intent; the API layer maps them to HTTP status codes. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotFoundError extends DomainError {}
export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}
export class ConflictError extends DomainError {}
