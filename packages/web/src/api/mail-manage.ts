import type {
  MailDeleteRequest,
  MailDeleteResponse,
  MailFlagRequest,
  MailFlagResponse,
  MailMoveRequest,
  MailMoveResponse,
  MailSearchRequest,
  MailSearchResponse,
} from "@argelanderspace/contracts";
import { acc, request } from "./mail";

/**
 * Every call resolves only after the IMAP server did. A rejection (MailApiError) means the server did not confirm:
 * normally nothing changed, but `connection_lost`/`unreachable` mean the outcome is UNKNOWN and callers must not claim either.
 */
export const setMailFlag = (id: string, input: MailFlagRequest) =>
  request<MailFlagResponse>(`${acc(id)}/messages/flag`, "POST", input);
export const moveMailMessage = (id: string, input: MailMoveRequest) =>
  request<MailMoveResponse>(`${acc(id)}/messages/move`, "POST", input);
export const deleteMailMessage = (id: string, input: MailDeleteRequest) =>
  request<MailDeleteResponse>(`${acc(id)}/messages/delete`, "POST", input);
/** POST so the search text stays out of URLs and access logs. */
export const searchMail = (id: string, input: MailSearchRequest, signal?: AbortSignal) =>
  request<MailSearchResponse>(`${acc(id)}/messages/search`, "POST", input, signal);
