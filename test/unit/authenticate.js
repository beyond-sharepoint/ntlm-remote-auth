"use strict";

require('mocha-generators').install();
const moment = require("moment");

describe('ntlm-remote-auth', function () {
    describe('authenticate', function () {

        before(function () {
            // If we're not live, setup the nock from the pre-recorded fixture.
            if (!isLive) {
                let nockDefs = postProcessNockFixture("nock-authenticate.json");
                //  Load the nocks from pre-processed definitions.
                let nocks = nock.define(nockDefs);
            }
        });

        it('should export a function', function* () {
            expect(ntlmRemoteAuth).to.be.a("function");
        });

        it('should contain an authenticate function', function* () {
            expect(ntlmRemoteAuth.authenticate).to.be.a("function");
        });

        it('should throw when NTLM authentication is not being used ', function* () {
            let thrown = false;
            let message = "";

            try {
                var result = yield ntlmRemoteAuth.authenticate({
                    workstation: testSettings.invalid.workstation,
                    domain: testSettings.invalid.domain,
                    username: testSettings.invalid.username,
                    password: testSettings.invalid.password,
                    tenantDomain: testSettings.invalid.url
                });
            }
            catch (ex) {
                thrown = true;
                message = ex.message;
            }

            expect(thrown).to.be.true;
            expect(message).to.be.equal("www-authenticate not found on response of second request");
        });

        it('should throw unauthorized with invalid user', function* () {
            let thrown = false;
            let message = "";

            try {
                var result = yield ntlmRemoteAuth.authenticate({
                    workstation: testSettings.invalid.workstation,
                    domain: testSettings.invalid.domain,
                    username: testSettings.invalid.username,
                    password: testSettings.invalid.password,
                    tenantDomain: testSettings.valid.url
                });
            }
            catch (ex) {
                thrown = true;
                message = ex.message;
            }

            expect(thrown).to.be.true;
            expect(message).to.be.equal("401 UNAUTHORIZED");
        });

        it('should throw unauthorized with invalid password', function* () {
            let thrown = false;
            let message = "";

            try {
                var result = yield ntlmRemoteAuth.authenticate({
                    workstation: testSettings.valid.workstation,
                    domain: testSettings.valid.domain,
                    username: testSettings.valid.username,
                    password: testSettings.invalid.password,
                    tenantDomain: testSettings.valid.url
                });
            }
            catch (ex) {
                thrown = true;
                message = ex.message;
            }

            expect(thrown).to.be.true;
            expect(message).to.be.equal("401 UNAUTHORIZED");
        });

        it('should authenticate and contain a context info that expires in the future.', function* () {
            let thrown = false;
            let message = "";

            let result = yield ntlmRemoteAuth.authenticate({
                workstation: testSettings.valid.workstation,
                domain: testSettings.valid.domain,
                username: testSettings.valid.username,
                password: testSettings.valid.password,
                tenantDomain: testSettings.valid.url
            });

            expect(result).to.not.equal(undefined);
            expect(moment(result.contextInfo.expires).isAfter(moment())).to.be.true;
        });
    });
});