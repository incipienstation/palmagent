// Lets handlers translate failures into HTTP status codes.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
