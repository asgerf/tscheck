#!/usr/bin/env node
var fs = require('fs');
var tsconvert = require('./tsconvert');
require('sugar');
var Map = require('./map');
var util = require('util');

var program = require('commander');
program.parse(process.argv);

// usage: tscheck SNAPSHOT INTERACE
var snapshotFile = program.args[0]
var snapshotText = fs.readFileSync(snapshotFile, 'utf8');
var snapshot = JSON.parse(snapshotText);

var typeDeclFile = program.args[1];
var typeDeclText = fs.readFileSync(typeDeclFile, 'utf8');
var typeDecl = typeDeclFile.endsWith('.json') ? JSON.parse(typeDeclText) : tsconvert(typeDeclText);

// reportUniqueError attempts to avoid repeating previous errors
var unique_error_ids = new Map;
function reportUniqueError(uid, msg) {
	if (unique_error_ids.has(uid))
		return;
	unique_error_ids.put(uid, true)
	console.log(msg)
}

function lookupObject(key) {
	var obj = snapshot.heap[key];
	if (!obj) {
		throw new Error("Missing object with key " + key)
	}
	return obj;
}

function lookupQType(qname) {
	var t = typeDecl.env[qname];
	if (!t) {
		reportUniqueError('missing:' + qname, "Error: Type " + qname + " is not defined");
	}
	return t;
}
function findPrtyDirect(obj, name) {
	return obj.properties.find(function(x) { return x.name == name });
}
function findPrty(obj, name) {
	while (obj) {
		var prty = findPrtyDirect(obj,name)
		if (prty)
			return prty;
		obj = obj.prototype && lookupObject(obj.prototype.key);
	}
	return null;
}

function formatType(type) {
	switch (type.type) {
		case 'reference':
			return type.name;
		case 'object':
			var members = []
			members = members.concat(type.properties.map(formatTypeProperty));
			members = members.concat(type.properties.map(formatTypeCall));
			return '{' + members.join(', ') + '}'
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'void':
			return 'void';
		case 'any':
			return 'any';
	}
	return util.inspect(type)
}
function formatValue(value, depth) {
	if (typeof depth === 'undefined')
		depth = 1;
	if (typeof value === 'object' && value !== null) {
		if (depth <= 0)
			return '[Object]'
		return '{ ' + lookupObject(value.key).properties.map(function(prty) { return prty.name + ': ' + formatValue(prty.value,depth-1) }).join(', ') + ' }'
	} else {
		return util.inspect(value)
	}
}

var assumptions = new Map

function qualify(host, name) {
	return host === '' ? name : (host + '.' + name);
}

function check(type, value, path) {
	function reportError(msg) {
		console.log((path || '<global>') + ": " + msg)
	}
	function must(condition) {
		if (!condition) {
			reportError("expected " + formatType(type) + " but found " + formatValue(value));
			return false;
		} else {
			return true;
		}
	}
	if (!type) {
		throw new Error("Undefined type on path: " + path)
	}
	if (type.type === 'reference') {
		if (value.key) {
			if (assumptions.has(value.key + '@' + type.name))
				return; // we are assuming this typing holds
			assumptions.put(value.key + '@' + type.name, true)	
		}
		type = lookupQType(type.name);
		if (!type)
			return; // an error was already issued, just assume check passed
	}
	switch (type.type) {
		case 'object':
			if (must(typeof value === 'object')) {
				var obj = lookupObject(value.key)
				for (var k in type.properties) {
					var typePrty = type.properties[k]
					var objPrty = findPrty(obj, k)
					if (!objPrty) {
						if (!typePrty.optional) {
							reportError("missing property " + k)
						}
					} else {
						if (objPrty.value) {
							check(typePrty.type, objPrty.value, qualify(path,k))
						} else {
							// todo: getters and setters require static analysis
						}
					}
				}
			}
			break;
		case 'type-param':
			break; // todo: handle generics. for now we just assume type params match anything
		case 'generic':
			check(type.base, value, path) // just check against raw type (anything matches 'type-param' at the moment)
			break;
		case 'enum':
			must(typeof value === 'number')
			break;
		case 'string-const':
			must(typeof value === 'string' && value === type.value)
			break;
		case 'number':
			must(typeof value === 'number');
			break;
		case 'string':
			must(typeof value === 'string'); // todo: instances of String
			break;
		case 'boolean':
			must(typeof value === 'boolean');
			break;
		case 'any':
			break; // no check necessary
		case 'void':
			break; // ?
		default:
			throw new Error("Unrecognized type type: " + type.type)
	}
}

check(lookupQType(typeDecl.global), {key: snapshot.global}, '');

