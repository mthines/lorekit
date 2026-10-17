# Specs: every page of the website renders

Target: local

# One spec per page.tsx under packages/web/src/app — specs.test.ts fails the PR
# when a page has none. Assert the heading a visitor sees, exactly as rendered.
# Format guide: specs/README.md.

## Spec 1: The landing page renders
url: /
flow:
  - WHEN page loads
    THEN {role: "heading", name: /Your coding agents forget\./} is visible

## Spec 2: The login page renders
url: /login
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Sign in to LoreKit"} is visible

## Spec 3: The forgot-password page renders
url: /forgot-password
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Reset your password"} is visible

## Spec 4: The update-password page renders
url: /update-password
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Set a new password"} is visible

## Spec 5: The welcome page renders
url: /welcome
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Welcome to LoreKit"} is visible

## Spec 6: The blog index renders
url: /blog
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Blog"} is visible

## Spec 7: A blog post renders
url: /blog/self-healing-agents
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Self-healing agents are just a loop you forgot to build"} is visible

## Spec 8: The docs index forwards to Getting started
url: /docs
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Getting started"} is visible

## Spec 9: A docs page renders
url: /docs/offline
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Offline storage"} is visible

## Spec 10: An old /learn link forwards to its doc
url: /learn/remote
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Remote storage"} is visible

## Spec 11: The Lore Explorer renders
url: /lore
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Lore Explorer"} is visible

## Spec 12: Insights renders
url: /insights
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Insights"} is visible

## Spec 13: Onboarding forwards to Getting started
url: /onboarding
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Getting started"} is visible

## Spec 14: Settings › API keys renders
url: /settings/api-keys
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "API keys"} is visible

## Spec 15: Settings › Audit logs renders
url: /settings/audit
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Audit Logs"} is visible

## Spec 16: Settings › Developer renders
url: /settings/developer
preconditions:
  - User is signed in (handled by the e2e auth setup)
  - Not on production: answers 404 there for any account outside DEVELOPER_EMAILS (lib/developer-users.ts)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Developer"} is visible

## Spec 17: Settings › Retention policies renders
url: /settings/grooming
preconditions:
  - User is signed in (handled by the e2e auth setup)
  - The retention-policies flag is on (its default)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Retention Policies"} is visible

## Spec 18: Settings › Integrations renders
url: /settings/integrations
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "GitHub App"} is visible

## Spec 19: Settings › Organization renders
url: /settings/organization
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Organization"} is visible

## Spec 20: Settings › Plan renders
url: /settings/plan
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Plan"} is visible

## Spec 21: Settings › User renders
url: /settings/user
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "User"} is visible

## Spec 22: The tutorials index forwards to its doc
url: /tutorials
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Offline storage"} is visible

## Spec 23: Tutorials › Offline forwards to its doc
url: /tutorials/offline
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Offline storage"} is visible

## Spec 24: Tutorials › Organization forwards to its doc
url: /tutorials/organization
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Team sharing"} is visible

## Spec 25: Tutorials › Private forwards to its doc
url: /tutorials/private
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Private lore"} is visible

## Spec 26: Tutorials › Remote forwards to its doc
url: /tutorials/remote
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Remote storage"} is visible

## Spec 27: Tutorials › Tags forwards to its doc
url: /tutorials/tags
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Tags & scopes"} is visible

## Spec 28: Tutorials › Use cases forwards to its doc
url: /tutorials/use-cases
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Use cases"} is visible
