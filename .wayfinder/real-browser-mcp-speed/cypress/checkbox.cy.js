const runs = Number(Cypress.expose('BENCHMARK_RUNS') || 30);
const testUrl = 'https://the-internet.herokuapp.com/checkboxes';

describe(`the-internet.herokuapp.com checkbox workflow (${runs} samples)`, () => {
  for (let iteration = 1; iteration <= runs; iteration += 1) {
    it(`loads the page and checks checkbox 1 — sample ${iteration}`, () => {
      cy.task('benchmark:start');
      cy.visit(testUrl);
      cy.get('#checkboxes input[type="checkbox"]')
        .first()
        .should('not.be.checked')
        .click()
        .should('be.checked');
      cy.task('benchmark:stop', { iteration }).then((elapsedMs) => {
        expect(elapsedMs).to.be.greaterThan(0);
      });
    });
  }
});
