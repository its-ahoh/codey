// Folding a cookie's host down to the site a user would recognise.
//
// A user picks "github.com" and means its api. and gist. cookies too, so the
// picker has to group hosts. Chrome exposes no public-suffix API to an
// extension and shipping the whole PSL for this would be absurd, so this uses
// the usual heuristic: two labels, or three when the last is a country code
// sitting behind one of the common second levels (co.uk, com.cn, com.au).
//
// It over-groups shared-suffix hosting (every user site under github.io reads
// as one site), which is why the picker shows cookie counts and the copy is
// confirmed - the user sees how much is going before it goes.
//
// Kept in its own file, free of Chrome APIs, so the service worker can
// `importScripts` it and the tests can evaluate it on its own.

const MULTI_LABEL_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])

function siteOfHost(host) {
  const labels = String(host || '').replace(/^\./, '').toLowerCase().split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const last = labels[labels.length - 1]
  const secondLast = labels[labels.length - 2]
  const take = last.length === 2 && MULTI_LABEL_SUFFIXES.has(secondLast) ? 3 : 2
  return labels.slice(-take).join('.')
}
