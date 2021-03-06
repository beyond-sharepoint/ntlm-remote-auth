"use strict";

require('mocha-generators').install();
const URI = require("urijs");

describe('ntlm-remote-auth', function () {
    describe('integration', function () {

        before(function () {

            //If we're not live, setup the nock from the pre-recorded fixture.
            if (!isLive) {
                let nockDefs = postProcessNockFixture("nock-integration.json");
                //  Load the nocks from pre-processed definitions.
                let nocks = nock.define(nockDefs);
            }
        });

        it('should be able to upload a file with authentication', function* () {

            let ctx = yield ntlmRemoteAuth.authenticate(testSettings.valid.url, "", testSettings.valid.domain, testSettings.valid.username, testSettings.valid.password);

            let docLibUrl = "Documents";
            let fileName = "test1234.txt";

            let result = yield ctx.request.postAsync({
                url: URI.joinPaths("/_api/web/", `GetFolderByServerRelativeUrl('${URI.encode(docLibUrl)}')/`, "files/", `add(url='${URI.encode(fileName)}',overwrite=true)`).href(),
                body: "Hello, world!"
            });
            expect(result.statusCode).to.be.equal(200);
            expect(result.body.d.__metadata.type).to.equal("SP.File");
        });

        it('should work with non-shortcut functions', function* () {
            let ctx = yield ntlmRemoteAuth.authenticate(testSettings.valid.url, "", testSettings.valid.domain, testSettings.valid.username, testSettings.valid.password);

            let docLibUrl = "Documents";
            let fileName = "test1234.txt";

            let result = yield ctx.requestAsync({
                method: "POST",
                url: URI.joinPaths("/_api/web/", `GetFolderByServerRelativeUrl('${URI.encode(docLibUrl)}')/`, "files/", `add(url='${URI.encode(fileName)}',overwrite=true)`).href(),
                body: "Hello, world!"
            });
            expect(result.statusCode).to.be.equal(200);
            expect(result.body.d.__metadata.type).to.equal("SP.File");
        });

        it('should resolve after a non-200 response', function* () {

            let ctx = yield ntlmRemoteAuth.authenticate(testSettings.valid.url, "", testSettings.valid.domain, testSettings.valid.username, testSettings.valid.password);

            let docLibUrl = "FooBarDirThatDoesntExist";

            let result = yield ctx.request.getAsync({
                url: URI.joinPaths("/_api/web/", `GetFolderByServerRelativeUrl('${URI.encode(docLibUrl)}')/`).href(),
            });

            expect(result.statusCode).to.be.equal(404);
            expect(result.body.error.message.value).to.equal("File Not Found.");
        });

        it('should allow multiple independent in-flight authentication requests', function* () {
            let ctx1 = yield ntlmRemoteAuth.authenticate(testSettings.valid.url, "", testSettings.valid.domain, testSettings.valid.username, testSettings.valid.password);
            let ctx2 = yield ntlmRemoteAuth.authenticate(testSettings.valid.url, "", testSettings.valid.domain, testSettings.valid.username, testSettings.valid.password);

            expect(ctx1.contextInfo).to.not.equal(ctx2.contextInfo);
        });

        it('should return result in promise continuation', function (done) {
            ntlmRemoteAuth.authenticate(testSettings.valid.url, "", testSettings.valid.domain, testSettings.valid.username, testSettings.valid.password)
                .then(function (ctx) {

                    let docLibUrl = "Documents";
                    let fileName = "test2141.txt";

                    let uploadRequestPromise = ctx.request({
                        method: "POST",
                        url: URI.joinPaths("/_api/web/", `GetFolderByServerRelativeUrl('${URI.encode(docLibUrl)}')/`, "files/", `add(url='${URI.encode(fileName)}',overwrite=true)`).href(),
                        body: "Hello, world!"
                    }).then(function (response) {
                        expect(response.statusCode).to.be.equal(200);
                        expect(response.body.d.__metadata.type).to.equal("SP.File");
                        done();
                    });
                });
        });
    });
});