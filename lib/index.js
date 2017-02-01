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

Promise.promisifyAll(request);

const ContextInfoServicePath = "/_api/contextinfo";

module.exports = (function () {
  let _type1GetAsync = null;
  let _type3Request = null;

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
   * Sends a type1 message for the given credentials and http options.
   */
  let sendType1Message = function* (credentials, options) {

    let type1msg = ntlm.createType1Message(credentials);
    _.set(options, 'headers.Connection', 'keep-alive');
    _.set(options, "headers.Authorization", type1msg);

    // send type1 message to server:
    return yield _type1GetAsync(options);
  }

  /**
   * Performs the actual request, using the type1response and closing the keep-alive connection.
   */
  let sendType3Message = function* (type1Response, credentials, options) {
    // catch redirect here:
    if (type1Response.headers.location) {
      options.url = type1Response.headers.location;
      return yield _type3Request[options.method + "Async"](options);
    }

    if (!type1Response.headers['www-authenticate'])
      throw new Error('www-authenticate not found on response of second request');

    // parse type2 message from server:
    let type2msg = yield ntlm.parseType2Message(type1Response.headers['www-authenticate']);
    if (!type2msg)
      throw new Error('Could not parse type2 message.');

    // create type3 message:
    let type3msg = ntlm.createType3Message(type2msg, credentials);

    // build type3 request from options.
    _.set(options, "headers.Connection", "Close");
    _.set(options, "headers.Authorization", type3msg);

    let method = (options.method || "GET").toLowerCase();

    // send type3 message to server:
    return _type3Request[method + "Async"](options);
  }

  let obtainContextInfo = function* (tenantDomain, credentials, keepaliveAgent) {

    if (!keepaliveAgent)
      keepaliveAgent = getKeepaliveAgent(tenantDomain);

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
    let type1Response = yield sendType1Message(credentials, options);
    let type3Response = yield sendType3Message(type1Response, credentials, options);
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

  let ensureContextInfo = function* (tenantDomain, credentials, currentContextInfo) {
    if (!currentContextInfo)
      throw Error("Context Info must be supplied.");

    if (!moment(currentContextInfo.expires).isBefore(moment()))
      return currentContextInfo;

    return yield obtainContextInfo(tenantDomain, credentials);
  };

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

    //Normalize the tenantDomain
    let tenantDomainUrl = url.parse(tenantDomain);
    tenantDomain = `${tenantDomainUrl.protocol}//${tenantDomainUrl.hostname}`;

    let keepaliveAgent = getKeepaliveAgent(tenantDomain);

    //Setup request default objects
    let type1Request = request.defaults({
      baseUrl: tenantDomain,
      agent: keepaliveAgent,
      followRedirect: false
    });
    _type1GetAsync = Promise.promisify(type1Request.get);

    _type3Request = request.defaults({
      baseUrl: tenantDomain,
      headers: {
        "Accept": "application/json;odata=verbose",
        "Content-Type": "application/json;odata=verbose"
      },
      agent: keepaliveAgent,
      followRedirect: false,
      json: true
    });
    Promise.promisifyAll(_type3Request);

    let contextInfoResult = yield obtainContextInfo(tenantDomain, credentials);

    _type3Request = _type3Request.defaults({
      baseUrl: contextInfoResult.SiteFullUrl,
      headers: {
        "X-RequestDigest": contextInfoResult.FormDigestValue
      }
    });
    Promise.promisifyAll(_type3Request);

    let defaultSPRequest = _type3Request.defaults();

    ['get', 'put', 'patch', 'post', 'delete', 'options'].forEach(function (method) {
      defaultSPRequest[method] = function (options, callback) {
        options.method = method;
        _.set(options, "baseUrl", contextInfoResult.SiteFullUrl);
        _.set(options, "headers.X-RequestDigest", contextInfoResult.FormDigestValue);

        try {
          Promise.coroutine(function* () {
            let type1Response = yield sendType1Message(credentials, options);
            return yield sendType3Message(type1Response, credentials, options);
          })().then(function (result) {
            callback(null, result);
          });
        } catch (err) {
          callback(err, null);
        }
      };
    });
    Promise.promisifyAll(defaultSPRequest);

    return {
      contextInfo: contextInfoResult,
      ensureContextInfo: function () {
        contextInfoResult = ensureContextInfo(tenantDomain, credentials, contextInfoResult);
        return contextInfoResult;
      },
      ntlm: ntlm,
      request: defaultSPRequest,
      requestAsync: Promise.promisify(defaultSPRequest),
      sendType1Message: sendType1Message,
      sendType3Message: sendType3Message
    }
  };

  let authenticateWrapper = co.wrap(authenticate);
  return Object.assign(authenticateWrapper, {
    authenticate: co.wrap(authenticate)
  });

})();