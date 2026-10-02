/** A single cell cannot be read as the attribute's type. Becomes a row error. */
export class CellError extends Error {}

/** The file as a whole is unusable. Becomes a file error in the report. */
export class FileError extends Error {}

/** Maps to an HTTP status in the controller. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
