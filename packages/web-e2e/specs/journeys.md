# Specs: journeys across pages

Target: local

# Flows a visitor takes, beyond "the page renders". Format guide: specs/README.md.
# A flow the grammar cannot express (a reload, a link the page renders twice —
# e.g. the landing header's Docs/Blog, which the footer repeats — or a
# request-level check) goes in src/journeys/*.e2e.ts instead.

## Spec 1: The login page offers GitHub, email and magic-link sign-in
url: /login
flow:
  - WHEN page loads
    THEN {role: "button", name: "Continue with GitHub"} is visible
    AND {role: "button", name: "Or email me a magic link"} is visible
  - WHEN {role: "button", name: "Continue with email"} is clicked
    THEN {label: "Email address"} is visible
    AND {label: "Password"} is visible
    AND {role: "link", name: "Forgot password?"} is visible
  - WHEN {role: "button", name: "Back"} is clicked
    THEN {role: "button", name: "Continue with email"} is visible

## Spec 2: An unknown URL shows the not-found page
url: /this-page-does-not-exist-e2e
flow:
  - WHEN page loads
    THEN {text: "Page not found"} is visible
    AND network: GET /this-page-does-not-exist-e2e returned 404

## Spec 3: A signed-in visitor to /login goes where ?next= points
url: /login?next=%2Fsettings%2Fuser
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "User"} is visible
