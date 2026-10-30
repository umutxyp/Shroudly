/*
 * Supporting Shroudly: the PayPal campaign and the bank accounts that take
 * transfers (donate.json, also read by the Android app's Support.kt and its
 * test, so both show the same). Each account is for the countries whose
 * banks send to it as a local transfer; from anywhere else, an international
 * (Swift) transfer to the GBP account, which takes them from more than 150
 * countries.
 */

import DATA from './donate.json';

export const PAYPAL_URL = DATA.paypal;
export const RECIPIENT = DATA.recipient;
export const ACCOUNTS = DATA.accounts;
export const PAYPAL_QR = './donate/paypal-qr.png';

/* The account for a country (ISO 3166 code, e.g. from the system's region). */
export function accountFor(country) {
  const c = String(country || '').toUpperCase();
  return ACCOUNTS.find((a) => a.countries.includes(c)) || ACCOUNTS.find((a) => a.id === 'swift');
}

/* Countries from where neither PayPal nor the bank accounts can take a
 * donation: Shroudly does not bring it up there by itself. */
export const canPayFrom = (country) => !DATA.noPay.includes(String(country || '').toUpperCase());

/* Field names a bank's form uses in its own country stay as they are there;
 * the rest are translated. */
const FIELD_LABELS = {
  iban: 'IBAN', swift: 'Swift/BIC', sortCode: 'Sort code', routing: 'Routing number (ACH, wire)',
  accountType: 'Account type', bsb: 'BSB', institution: 'Institution number', transit: 'Transit number',
  bankCode: 'Bank code', branchCode: 'Branch code', brstn: 'BRSTN',
};
export const fieldLabel = (key, t) => (key === 'account' ? t('supportAccountNumber') : FIELD_LABELS[key] || key);
