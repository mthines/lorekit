# Specs: journeys across pages

Target: local

# Flows a visitor takes, beyond "the page renders". Format guide: specs/README.md.
# A flow the grammar cannot express (a reload, a link the page renders twice —
# e.g. the landing header's Docs/Blog, which the footer repeats — or a
# request-level check) goes in src/journeys/*.e2e.ts instead.

## Spec 1: The login page offers GitHub, email and magic-link sign-in up front
url: /login
flow:
  - WHEN page loads
    THEN {role: "tab", name: "Sign in"} has aria-selected: true
    AND {role: "button", name: "Continue with GitHub"} is visible
    AND {label: "Email address"} is visible
    AND {label: "Password"} is visible
    AND {role: "link", name: "Forgot password?"} is visible
  - WHEN {role: "button", name: "Email me a magic link instead"} is clicked
    THEN {role: "button", name: "Send magic link"} is visible
  - WHEN {role: "button", name: "Use a password instead"} is clicked
    THEN {label: "Password"} is visible

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

## Spec 4: The sign-up link greets a newcomer and opens the form in create-account mode
url: /login?mode=signup
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Create your free LoreKit account"} is visible
    AND {role: "tab", name: "Create account"} has aria-selected: true
    AND {role: "button", name: "Sign up with GitHub"} is visible
    AND {role: "button", name: "Create account"} is visible
    AND {text: "At least 8 characters."} is visible
  - WHEN {role: "tab", name: "Sign in"} is clicked
    THEN {role: "tab", name: "Sign in"} has aria-selected: true
    AND {role: "link", name: "Forgot password?"} is visible
  - WHEN {role: "tab", name: "Sign in"} is pressed with "ArrowLeft"
    THEN {role: "tab", name: "Create account"} has aria-selected: true
    AND {role: "button", name: "Create account"} is visible
  - WHEN {role: "tab", name: "Create account"} is pressed with "End"
    THEN {role: "tab", name: "Sign in"} has aria-selected: true
