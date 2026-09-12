/**
 * Participant-facing copy (spec §9). Every message is a versioned campaign
 * content key with data-driven variables; these are the English defaults used
 * by the TEST ONLY campaign and overridden per campaign version. Entry
 * confirmations never imply a prize was won; duplicate messages never identify
 * another submitter; rejection reasons map to approved reason codes.
 */
export const DEFAULT_COPY = {
  menu_home: "Welcome to {campaign}!\n1. Register\n2. Enter the promotion\n3. How it works\n4. Terms & conditions\n5. Prizes\n6. Winners\n{status_line}8. Help\n\nReply with a number.",
  menu_status_line: "7. My entries\n",
  menu_hint: "Reply MENU at any time to return here.",
  no_campaign: "There is no promotion running right now. Please check back later.",
  campaign_closed: "This promotion has closed. Thank you for taking part. Reply 6 to see the winners.",
  campaign_paused: "Entries are paused for a short while. Please try again later. Reply MENU for other options.",
  not_registered_for_entry: "You need to register first (it only takes a minute). Reply 1 to register.",
  ask_first_name: "Let's get you registered. What is your FIRST NAME?",
  ask_surname: "Thanks {first_name}. What is your SURNAME?",
  ask_identity: "What is your national ID number? (letters and numbers only). This is kept private and is used only to verify winners.",
  ask_identity_retry: "That doesn't look like an ID number. Reply with letters and numbers only, or CANCEL.",
  ask_location: "Which town or city do you live in?",
  ask_retry_short: "Please reply with at least 2 characters.",
  confirm_details: "Please confirm your details:\nName: {first_name} {surname}\nID: {identity_masked}\nTown: {location}\nWhatsApp number: {phone}\n\nReply YES to confirm, or reply with the number to change: 1 name, 2 surname, 3 ID, 4 town.",
  // Used when the campaign version does not collect the national ID at
  // registration: offering "3 ID" there did nothing at all when pressed.
  confirm_details_no_identity: "Please confirm your details:\nName: {first_name} {surname}\nTown: {location}\nWhatsApp number: {phone}\n\nReply YES to confirm, or reply with the number to change: 1 name, 2 surname, 3 town.",
  ask_terms: "By entering you confirm you are 18 or older and accept the Promotion Terms ({terms_version}) and Privacy Notice ({privacy_version}). Read them: {terms_url}\n\nReply YES to accept and continue, or NO to stop.",
  terms_declined: "No problem. You have not been registered and nothing has been saved. Reply MENU to start again.",
  registered: "You're registered, {first_name}! You can now enter the promotion.",
  already_registered: "You're already registered as {first_name} {surname}. Reply 2 to enter the promotion, or 1 to update your details.",
  ask_outlet_retailer: "Where did you buy? Choose the RETAILER:\n{options}\nReply with a number, or type part of the branch name to search.",
  ask_outlet_town: "{retailer}: choose the TOWN:\n{options}\nReply with a number, BACK, or type to search.",
  ask_outlet_branch: "{retailer}, {town}: choose the BRANCH:\n{options}\nReply with a number, BACK, or type to search.",
  outlet_search_results: "Matching branches ({shown} of {total}):\n{options}\nReply with a number, MORE for the next page, or type again to search. BACK for the list.",
  outlet_no_match: "No branch matched \"{query}\". Try another word (retailer, town or branch), or reply BACK for the list.",
  outlet_choose_number: "Please reply with one of the numbers shown, type to search, or BACK.",
  outlet_confirmed: "Outlet: {outlet}.\n\nNow send ONE clear photo of the whole receipt. Make sure the shop name, date, receipt number and the sugar line are readable. Avoid glare and shadows.",
  need_image: "Please send a PHOTO of your receipt (use the camera or gallery). Voice notes, stickers and text cannot be checked. Reply MENU to go back.",
  media_missing: "We couldn't download that image. Please send the photo again.",
  media_rejected: "That file couldn't be used ({reason}). Please send a clear JPEG or PNG photo of the receipt.",
  received: "We have received your receipt. Your submission reference is {reference}. We are checking it now and will message you with the result.",
  processing_wait: "Your receipt {reference} is still being checked. We'll message you as soon as it's done — no need to send it again.",
  qualified: "Thank you for entering {campaign}! Your receipt {reference} qualifies and ONE entry has been added to the draw.{count_line} Good luck!\n\nYou can enter again with a different qualifying receipt — reply 2.",
  qualified_count_line: " You now have {count} qualified entries.",
  duplicate: "This receipt has already been used for this promotion, so no new entry was added. Please submit a different qualifying receipt. Reply 2 to enter again.",
  not_qualified: "Thanks for your receipt {reference}. Unfortunately it does not qualify: {reason}. You can enter with another qualifying receipt — reply 2.",
  reupload: "We couldn't read receipt {reference}: {reason}. Please take a new photo of the whole receipt in good light and send it again. Reply 2 to try again.",
  under_review: "Receipt {reference} needs a quick manual check by our team. We'll message you with the result. You can still send other receipts in the meantime — reply 2.",
  delayed: "Checking receipt {reference} is taking longer than usual. It is safely stored — please don't send the same receipt again. We'll message you when it's done.",
  review_result_qualified: "Good news: after review, receipt {reference} qualifies and ONE entry has been added to the draw.{count_line}",
  review_result_not_qualified: "After review, receipt {reference} does not qualify: {reason}. You can enter with another qualifying receipt — reply 2.",
  review_result_reupload: "After review, we need a clearer photo of receipt {reference}: {reason}. Please send it again — reply 2.",
  review_result_duplicate: "After review, receipt {reference} was found to have been used already, so no entry was added.",
  status: "Your entries for {campaign}:\nQualified entries: {qualified}\nBeing checked: {pending}\nDid not qualify: {rejected}\n{recent}",
  status_recent_line: "- {reference}: {outcome}",
  status_disabled: "Entry status is not available in this promotion. Reply MENU for other options.",
  mechanics: "How it works: buy at least {min_packs} x {pack_label} of {product} in ONE purchase at a participating outlet, keep the receipt, and send us a photo of it here. Every qualifying receipt gives you one entry into the weekly draw. Enter as many times as you like with different receipts.",
  terms: "Promotion Terms ({terms_version}) and Privacy Notice ({privacy_version}): {terms_url}\nSummary: one entry per qualifying receipt; receipts cannot be reused; winners are verified before prizes are released.",
  prizes: "Prizes: {prizes}\n{prize_artwork_note}",
  prizes_artwork_note: "(Prize artwork is available on request — reply PRIZE PIC.)",
  winners_none: "No winners have been published yet. Draws happen weekly — check back soon!",
  winners_periods: "Published winners by week:\n{options}\nReply with a number to see that week, or MENU.",
  winners_list: "{period} winners:\n{lines}\n\nReply with another week number, or MENU.",
  winners_line: "{rank}. {name} ({location}) — {prize}",
  help: "Help: reply 1 to register, 2 to enter, 3 how it works, 4 terms, 5 prizes, 6 winners, 8 help. MENU returns here, BACK goes one step back, CANCEL stops the current step. For support, reply SUPPORT.",
  support_handoff: "A member of our team will pick this up and reply here. Automatic replies are paused until they close the conversation.",
  support_active: "Our team is handling your conversation. Please wait for their reply.",
  // An unclaimed handoff used to freeze the participant out of every automated
  // flow for ever; it now hands the conversation back with an apology.
  support_timeout: "Sorry for the wait — nobody from our team was able to pick up your request. You can carry on here, or reply SUPPORT to try again.",
  cancel: "Cancelled. Reply MENU to start again.",
  // STOP is the universal WhatsApp opt-out; it used to be answered "Cancelled.
  // Reply MENU to start again." with the registration and consent still live.
  // NOTE: neither key names a campaign. domain.withdrawParticipant closes EVERY
  // consent and EVERY campaign enrolment for the number and sets the profile to
  // 'withdrawn' globally, so "you have been withdrawn from {campaign}" told a
  // participant enrolled in two promotions that one had ended when in fact both
  // had — and this copy is the consent record the participant sees.
  opted_out: "You have been withdrawn from our promotions. Your consent is recorded as withdrawn, your registration is closed and you will not be entered into any further draws. If this was a mistake, reply SUPPORT and our team can restore your registration.",
  opted_out_none: "You are not registered for {campaign}, so there is nothing to withdraw.",
  registration_withdrawn: "Your details were removed from our promotions at your request, so this number cannot be registered again automatically. Reply SUPPORT and our team will restore your registration.",
  // A profile that is not active but was NOT withdrawn by the participant
  // (suspended or blocked by staff, or any future status): saying "removed at
  // your request" would be false and unexplainable at the support desk.
  account_on_hold: "We can't continue with this number at the moment — the registration for it is on hold. Reply SUPPORT and our team will look into it for you.",
  something_went_wrong: "Sorry — something went wrong on our side and we could not complete that step. Please try again in a few minutes, or reply SUPPORT to speak to our team.",
  need_outlet_first: "Thanks for the photo. First tell us where you shopped — reply 2 to choose the outlet, then send the photo again.",
  claim_ack: "Thanks {first_name} — we have recorded your claim for {prize}. Our team will contact you on this number to verify your details. Please have your ID ready; we will confirm where and when to collect.",
  claim_not_found: "We could not match a prize claim for this number. If you believe this is an error, reply SUPPORT and our team will check for you.",
  unknown_input: "Sorry, I didn't understand that. {menu}",
  winner_contact: "Congratulations {first_name}! You have been selected as a winner in the {campaign} {period} draw for: {prize}. To claim your prize we need to verify your details. Please reply CLAIM to continue. Your claim reference is {claim_ref}. This offer is valid until {deadline}.",
  winner_collect: "Your prize ({prize}) is ready for collection at {outlet}. Bring your ID and quote claim reference {claim_ref}.",
  reason_labels: {
    ok: "ok",
    not_a_valid_receipt: "the image does not look like a till receipt",
    image_quality_insufficient: "the photo is too blurry, dark or cropped to read",
    campaign_not_open: "the promotion was not open at the time",
    participant_not_enrolled: "your registration was not found",
    participant_not_eligible: "you are not eligible under the promotion rules",
    missing_receipt_number: "the receipt number is not readable",
    missing_transaction_date: "the purchase date is not readable",
    transaction_date_unclear: "the purchase date is unclear",
    receipt_date_outside_campaign: "the purchase date is outside the promotion period",
    outlet_not_readable: "the shop name is not readable",
    outlet_selection_mismatch: "the receipt does not match the outlet you selected",
    outlet_not_participating: "that outlet is not part of this promotion",
    no_qualifying_product: "no qualifying product was found on the receipt",
    quantity_unclear: "the quantity of the qualifying product is unclear",
    below_minimum_quantity: "the qualifying quantity is below the minimum ({min_packs} x {pack_label})",
    entry_limit_reached: "the entry limit for this period has been reached",
    total_unclear: "the receipt total is not readable",
    duplicate_receipt: "the receipt was already used",
    ownership_dispute: "this receipt was also sent from another phone; a team member will check it",
    possible_duplicate_other_outlet: "this receipt looks like one already sent for a different branch; a team member will check it",
    possible_duplicate_same_outlet: "this receipt number matches one already sent from the same shop on the same day; a team member will check it",
    period_already_drawn: "this week's draw has already been made; a team member will decide this receipt",
    auto_qualification_paused: "automatic checks are paused; a team member will review it",
    reviewer_decision: "our team could not verify the receipt",
  },
};

export function renderCopy(content, key, vars = {}) {
  const src = (content && content[key] != null ? content[key] : DEFAULT_COPY[key]);
  if (src == null) return key;
  return String(src).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

export function reasonLabel(content, code, vars = {}) {
  const labels = { ...DEFAULT_COPY.reason_labels, ...((content && content.reason_labels) || {}) };
  return String(labels[code] || code || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

export function shortRef(receiptId) { return "R-" + String(receiptId || "").replace(/^rcpt_/, "").slice(0, 8).toUpperCase(); }
