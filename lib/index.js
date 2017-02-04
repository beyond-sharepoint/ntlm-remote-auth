"use strict";

const _ = require('lodash');
const request = require('request');
const url = require('url');
const ntlm = require('./ntlm');
const http = require('http');
const https = require('https');
const Promise = require("bluebird");
const co = require("bluebird-co");
const moment = require("moment");

const ContextInfoServicePath = "/_api/contextinfo";

module.exports = (function () {
  /**
   * Gets a keepaliveAgent for the given url.
   */
  let getKeepaliveAgent = function (tenantDomain) {
    // is https?
    let isHttps = false;
    let reqUrl = url.parse(tenantDomain);
    if (reqUrl.protocol == 'https:')
      isHttps = true;

    // set keepaliveAgent (http or https):
    let keepaliveAgent;

    if (isHttps) {
      keepaliveAgent = new https.Agent({ keepAlive: true });
    } else {
      keepaliveAgent = new http.Agent({ keepAlive: true });
    }

    return keepaliveAgent;
  };

  /**
   * Returns a promise that sends a type1 message for the given credentials and http options.
   */
  let sendType1Message = function (credentials, options, callback) {

    let type1msg = ntlm.createType1Message(credentials);
    _.set(options, 'headers.Connection', 'keep-alive');
    _.set(options, "headers.Authorization", type1msg);

    // send type1 message to server:
    return this.type1Request(options, callback);
  };

  /**
   * Returns a promise that performs the actual request, using the type1response and closing the keep-alive connection.
   */
  let sendType3Message = function (type1Response, credentials, options, callback) {
    // catch redirect here:
    if (type1Response.headers.location) {
      options.url = type1Response.headers.location;
      return this.type3Request(options, callback);
    }

    let wwwAuthenticateHeader = type1Response.headers['www-authenticate'];
    if (!wwwAuthenticateHeader)
      callback(new Error('www-authenticate not found on response of second request'));

    // parse type2 message from server:
    let type2msg = ntlm.parseType2Message(wwwAuthenticateHeader);

    if (!type2msg)
      callback(new Error('Could not parse type2 message.'));

    // create type3 message:
    let type3msg = ntlm.createType3Message(type2msg, credentials);

    // build type3 request from options.
    _.set(options, "headers.Connection", "Close");
    _.set(options, "headers.Authorization", type3msg);

    // send type3 message to server:
    return this.type3Request(options, callback);
  }

  /**
   * Obtain a SharePoint context info object using the specified credentials
   * 
   * @param tenantDomain {string} The SharePoint domain to request a access token
   * @param credentials {object} An object that contains the ntlm credentials to authenticate with
   * 
   * @returns {object} The ContextInfo object returned by the SharePoint's ContextInfo service endpoint.
   */
  let obtainContextInfo = function* (tenantDomain, credentials) {

    let options = {
      url: ContextInfoServicePath,
      method: "POST",
      headers: {
        "Accept": "application/json;odata=verbose",
        "Content-Type": "application/json;odata=verbose"
      },
      json: true,
    };

    //Authenticate while calling the ContextInfo service.
    let type1Response = yield Promise.promisify(sendType1Message).call(this, credentials, options);
    let type3Response = yield Promise.promisify(sendType3Message).call(this, type1Response, credentials, options);

    if (type3Response.statusCode !== 200) {
      throw new Error(type3Response.body || `${type3Response.statusCode} UNAUTHORIZED`);
    }

    let contextInfo = _.get(type3Response.body, "d.GetContextWebInformation");

    if (!contextInfo)
      throw Error("Unexpected Response from contextinfo service.");

    let expiresDateString = contextInfo.FormDigestValue.split(",")[1];
    contextInfo.expires = moment(new Date(expiresDateString)).add(1800, "seconds").toDate();

    return contextInfo;
  };

  /**
 * Given a contextInfo object, returns or renews it.
 * 
 * @param tenantDomain {string} The SharePoint domain to request a access token
 * @param credentials {object} An object that contains the ntlm credentials to authenticate with
 * @param contextInfo {object} A context info object to verify
 * 
 * @returns {object} The context info passed in or a new contextInfo object
 */
  let ensureContextInfo = function* (tenantDomain, credentials, currentContextInfo) {
    if (!currentContextInfo)
      throw Error("Context Info must be supplied.");

    if (!moment(currentContextInfo.expires).isBefore(moment()))
      return currentContextInfo;

    return yield obtainContextInfo.call(this, tenantDomain, credentials);
  };

  /**
 * Performs the authentication flow to the specified tenant domain with the specified credentials.
 * Returns an object that contains the contextInfo and a function that can be used to perform authenticated requests.
 * 
 * @param tenantDomain {string} The tenant SharePoint domain to request a access token
 * @param workstation {string} The client supplied workstation
 * @param domain {string} The domain that the user is a member of
 * @param username {string} The username to authenticate with
 * @param password {string} The secret associated with the username
 */
  let authenticate = function* (tenantDomain, workstation, domain, username, password) {

    let credentials = {};
    if (_.isObject(tenantDomain)) {
      credentials.username = tenantDomain.username;
      credentials.password = tenantDomain.password;
      credentials.domain = tenantDomain.domain;
      credentials.workstation = tenantDomain.workstation;

      tenantDomain = tenantDomain.tenantDomain;
    } else {
      credentials.workstation = workstation;
      credentials.domain = domain;
      credentials.username = username;
      credentials.password = password;
    }

    if (!credentials.domain)
      credentials.domain = "";

    if (!credentials.workstation)
      credentials.workstation = "";

    if (!credentials.username)
      throw Error("A username must be specified.");

    if (!credentials.password)
      throw Error("A password must be specified.");

    if (!tenantDomain)
      throw Error("A Tenant Domain must be specified.");

    let self = this;

    //Normalize the tenantDomain
    let tenantDomainUrl = url.parse(tenantDomain);
    tenantDomain = `${tenantDomainUrl.protocol}//${tenantDomainUrl.hostname}`;

    let keepaliveAgent = getKeepaliveAgent(tenantDomain);

    //Setup request default objects
    self.type1Request = request.defaults({
      baseUrl: tenantDomain,
      agent: keepaliveAgent,
      followRedirect: false
    });

    self.type3Request = request.defaults({
      baseUrl: tenantDomain,
      method: "GET",
      headers: {
        "Accept": "application/json;odata=verbose",
        "Content-Type": "application/json;odata=verbose"
      },
      agent: keepaliveAgent,
      followRedirect: false,
      json: true
    });

    self.contextInfoResult = yield obtainContextInfo.call(self, tenantDomain, credentials);

    let fnMethod = function (options, callback) {
      let invokeType1 = Promise.coroutine(function* () {
        //Auto-renew the context if needed.
        self.contextInfoResult = yield ensureContextInfo.call(self, tenantDomain, credentials, self.contextInfoResult);

        _.set(options, "baseUrl", self.contextInfoResult.SiteFullUrl);
        _.set(options, "headers.X-RequestDigest", self.contextInfoResult.FormDigestValue);

        return yield Promise.promisify(sendType1Message).call(self, credentials, options);
      });

      return invokeType1()
        .then(function (type1Response) {
          return sendType3Message.call(self, type1Response, credentials, options, callback);
        }, function (err) {
          callback(err, null);
        });
    };

    let defaultSPRequest = fnMethod;

    //Provide shortcuts for common operations.
    ['put', 'patch', 'post', 'head', 'delete', 'get', 'options'].forEach(function (method) {
      defaultSPRequest[method] = function (options, callback) {
        options.method = method;
        return fnMethod(options, callback);
      };
    });

    Promise.promisifyAll(defaultSPRequest);

    return {
      contextInfo: self.contextInfoResult,
      ensureContextInfo: ensureContextInfo.bind(self, tenantDomain, credentials, self.contextInfoResult),
      ntlm: ntlm,
      request: defaultSPRequest,
      requestAsync: Promise.promisify(defaultSPRequest),
      sendType1Message: sendType1Message.bind(self),
      sendType3Message: sendType3Message.bind(self),
      type1Request: self.type1Request,
      type3Request: self.type3Request
    }
  };

  let authenticateWrapper = co.wrap(authenticate);
  return Object.assign(authenticateWrapper, {
    authenticate: co.wrap(authenticate)
  });

})();