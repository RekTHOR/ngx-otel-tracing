// Jasmine on headless Chrome, with a no-sandbox variant for CI containers.
module.exports = function (config) {
  config.set({
    frameworks: ['jasmine'],
    plugins: [require('karma-jasmine'), require('karma-chrome-launcher')],
    customLaunchers: {
      ChromeHeadlessCI: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu'],
      },
    },
    reporters: ['progress'],
  });
};
