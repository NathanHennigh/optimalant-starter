# Reviewing and evaluating this reference

Start with [RIGHTS.md](RIGHTS.md). Reuse terms are undecided: the current permission is to clone and run locally for inspection and evaluation. Public visibility is not an open-source license or permission to redistribute this code or incorporate it into a product. Ask the repository owner before broader use. This guide does not change those terms.

## Useful feedback

A good issue includes the program ID/version, Node version, command or local API request, expected result, and actual result. Include a small synthetic reproduction. Never attach a real member history, production database, private program, or API key. Security issues should be reported privately as described in [SECURITY.md](SECURITY.md).

For a proposed extension, describe the program and the unsupported behavior before changing the engine. First check whether the supported data primitives already express it. New rule behavior needs explicit examples of success, failure, boundaries, and calendar behavior.

## Local checks

Use Node.js 22.13 or newer. There are no package dependencies to install.

```sh
npm run check:programs
npm test
npm run example
npm run evaluate
```

All of these run without an API key. The automated tests mock model requests. Do not require paid services in CI or include a real key in a test fixture.

When evaluating a program change, preserve the baseline and run it against the candidate using the same cases. Include the report and explain any expected-result changes. Passing synthetic cases demonstrates behavior on those cases; it does not substantiate a claim about health outcomes or user retention.

## Boundaries to preserve

- Program definitions and coaching instructions are separate from participant history.
- The rules engine owns progress; model output cannot award completion or rewards.
- Local examples remain runnable without provider credentials.
- API input cannot load program files, prompts, plugins, or arbitrary code.
- Public fixtures contain invented data only.
- The private application, private prompts, artwork, account details, and member data are not part of this repository.

Before submitting code for distribution, agree contribution and reuse terms with the owner. A license decision is still pending; do not label the project open source or promise unrestricted commercial reuse.
