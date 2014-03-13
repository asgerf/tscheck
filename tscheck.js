#!/usr/bin/env node 
var fs = require('fs');
var tscore = require('./tscore');
require('sugar');
var Map = require('./map');
var SMap = require('./smap')
var util = require('util');
var esprima = require('esprima');

var program = require('commander');
program.usage("FILE.jsnap FILE.d.ts [options]")
program.option('--compact', 'Report at most one violation per type path')
	   .option('--suggest', 'Suggest additions to the interface')
	   .option('--coverage', 'Print declaration file coverage')
	   .option('--no-warn', 'Squelch type errors')
	   .option('--no-jsnap', 'Do not regenerate .jsnap file, even if older than .js file')
	   .option('--verbose', 'More verbose fatal error messages')
program.parse(process.argv);

if (program.args.length === 0) {
	program.help()
}

function runGC() {
	if (this.gc) {
		gc();
	}
}

function fillExtension(path, ext) {
	if (path.endsWith('.' + ext))
		return path
	if (path.endsWith('.'))
		return path + ext
	if (path.endsWith('.js')) {
		path = path.substring(0, path.length - '.js'.length)
	} else if (path.endsWith('.d.ts')) {
		path = path.substring(0, path.length - '.d.ts'.length)
	}
	return path + '.' + ext
}
function getArgumentWithExtension(ext) {
	if (program.args.length === 1) {
		return fillExtension(program.args[0], ext)
	} else {
		return program.args.find(function(x) { return x.endsWith('.' + ext) })
	}
}
function generateSnapshot(jsfile, jsnapfile, callback) {
	// console.log("Regenerating jsnap file `" + jsnapfile + "` from `" + jsfile + "`")
	var spawn = require('child_process').spawn
	var fd = fs.openSync(jsnapfile, 'w')
	var proc = spawn('jsnap', [jsfile], {stdio:['ignore',fd,2]})
	proc.on('exit', function() {
		fs.close(fd)
	})
	proc.on('close', function(code) {
		if (code !== 0) {
			console.error("jsnap failed with exit code " + code)
			process.exit(1)
		}
		callback(jsnapfile)
	})
}
function checkSnapshot(jsfile, jsnapfile, callback) {
	if (fs.existsSync(jsnapfile)) {
		var js_stat = fs.statSync(jsfile)
		var jsnap_stat = fs.statSync(jsnapfile)
		if (jsnap_stat.mtime >= js_stat.mtime) {
			callback(jsnapfile)
			return
		}
	}
	generateSnapshot(jsfile, jsnapfile, callback)
}

var load_handlers = []
function onLoaded(fn) {
	if (load_handlers === null) {
		fn();
	} else {
		load_handlers.push(fn)
	}
}

function fatalError(msg, e) {
	console.error(msg)
	if (program.verbose && e) {
		console.error(e.stack)
	}
	process.exit(1)
}

var LIB_ORIGIN = ">lib.d.ts"; // pad origin with ">" to ensure it does not collide with user input

var snapshot, typeDecl, sourceFileAst;
function initialize() {
	var sourceFile = getArgumentWithExtension('js')
	if (!sourceFile) {
		fatalError("No .js file specified")
	}
	if (!fs.existsSync(sourceFile)) {
		fatalError("Could not find " + sourceFile)
	}

	var typeDeclFile = getArgumentWithExtension('d.ts')
	if (!typeDeclFile) {
		fatalError("No .d.ts file specified")
	}
	if (!fs.existsSync(typeDeclFile)) {
		fatalError("Could not find " + typeDeclFile)
	}

	var snapshotFile = getArgumentWithExtension('jsnap')
	if (!snapshotFile) {
		snapshotFile = sourceFile + 'nap' // replace .js -> .jsnap
	}
	
	if (program.jsnap) {
		checkSnapshot(sourceFile, snapshotFile, loadInputs)
	} else {
		if (!fs.existsSync(snapshotFile)) {
			fatalError("Could not find " + snapshotFile)
		}
		loadInputs();
	}

	function loadInputs(snapshotFile) {
		// Load snapshot
		var snapshotText = fs.readFileSync(snapshotFile, 'utf8');
		try {
			snapshot = JSON.parse(snapshotText);
		} catch (e) {
			fatalError("Parse error in " + snapshotFile, e)
		}

		// Load TypeScript
		var typeDeclText = fs.readFileSync(typeDeclFile, 'utf8');

		var libFile = __dirname + "/lib/lib.d.ts";
		var libFileText = fs.readFileSync(libFile, 'utf8');

		try {
			typeDecl = tscore([
				{file: LIB_ORIGIN, text:libFileText},
				{file: typeDeclFile, text:typeDeclText}
			])
		} catch (e) {
			fatalError("Could not parse " + typeDeclFile + ": " + e, e)
		}

		// Load source code
		var sourceFileText = fs.readFileSync(sourceFile, 'utf8')
		try {
			sourceFileAst = esprima.parse(sourceFileText, {loc:true})
		} catch (e) {
			fatalError("Syntax error in " + sourceFileText + ": " + e, e)
		}

		load_handlers.forEach(function(fn) {
			fn();
		})
		load_handlers = null
	}
}
initialize()

// -----------------------------------
// 		Miscellaneous util stuff
// -----------------------------------

var unique_error_ids = new Map;
function reportUniqueError(uid, msg) {
	if (unique_error_ids.has(uid))
		return;
	unique_error_ids.put(uid, true)
	console.log(msg)
}


function qualify(host, name) {
	if (host === '')
		return name;
	if (host.startsWith('module:'))
		return host.substring('module:'.length) + '::' + name;
	return host + '.' + name;
}

function jsonMap(obj,fn) {
	var result = {}
	for (var k in obj) {
		result[k] = fn(obj[k])
	}
	return result
}


// ---------------------------
// 		Lookup functions
// ---------------------------

function lookupObject(key) {
	var obj = snapshot.heap[key];
	if (!obj) {
		throw new Error("Missing object with key " + key)
	}
	return obj;
}

function lookupQType(qname, targs) {
	var tdecl = typeDecl.env[qname];
	if (!tdecl) {
		reportUniqueError('missing:' + qname, "Error: Type " + qname + " is not defined");
		return null;
	}
	if (targs.length !== tdecl.typeParameters.length) {
		reportUniqueError('targs:' + qname, "Error: Type " + qname + " expects " + tdecl.typeParameters.length + " type arguments but got " + targs.length);
		return null;
	}
	if (targs.length === 0)
		return tdecl.object; // optimization: skip substitution step if there are no type arguments
	var tenv = new Map
	for (var i=0; i<targs.length; i++) {
		tenv.put(tdecl.typeParameters[i], targs[i])
	}
	return substType(tdecl.object, tenv)
}
function resolveTypeRef(t) {
	return lookupQType(t.name, t.typeArguments)
}

function getPrototype(key) {
	var obj = lookupObject(key)
	return obj.prototype && obj.prototype.key
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

// Cyclic Prototype Detection. (Mostly for debugging jsnap)

function checkCyclicPrototype(key) {
	var slow = key;
	var fast = key;
	while (true) {
		fast = getPrototype(fast)
		if (!fast)
			return false;
		fast = getPrototype(fast)
		if (!fast)
			return false;
		slow = getPrototype(slow)
		if (slow === fast)
			return true;
	}
}

// ---------------------------------
// 		 Name Type Expressions
// ---------------------------------

var tpath2type = new Map;
function nameType(type, tpath) {
	switch (type.type) {
		case 'object':
			type.path = tpath;
			tpath2type.put(tpath, type);
			for (var k in type.properties) {
				var typePrty = type.properties[k]
				nameType(typePrty.type, qualify(tpath, k))
			}
			if (type.numberIndexer) {
				nameType(type.numberIndexer, qualify(tpath, '[number]'))
			}
			if (type.stringIndexer) {
				nameType(type.stringIndexer, qualify(tpath, '[string]'))
			}
			type.calls.forEach(function(call,i) {
				call.typeParameters.forEach(function(tp,j) {
					tp.constraint && nameType(tp.constraint, qualify(tpath, 'call:' + i + 'bound:' + j))
				})
				call.parameters.forEach(function(parm,j) {
					nameType(parm.type, qualify(tpath, 'call:' + i + 'arg:' + j))
				})
				nameType(call.returnType, qualify(tpath, 'call:' + i + ':return'))
			})
			break;
		case 'reference':
			type.typeArguments.forEach(function(targ,i) {
				nameType(targ, qualify(tpath, 'typearg:' + i))
			})
			break;
	}
}
function nameAllTypes() {
	for (var k in typeDecl.env) {
		nameType(typeDecl.env[k].object, k)
	}	
}
onLoaded(nameAllTypes)

// ----------------------------------------------
// 		 Type Parameter Substitution
// ----------------------------------------------

function substTypeParameters(tparams, tenv) {
	if (tparams.length === 0)
		return { typeParams: [], tenv: tenv };
	tenv = tenv.clone()
	var typeParams = []
	tparams.forEach(function (tparam) {
		tenv.remove(tparam.name)
		typeParams.push({
			name: tparam.name,
			constraint: tparam.constraint && substType(tparam.constraint, tenv)
		})
	})
	return {
		typeParams: typeParams,
		tenv: tenv
	}
}
function substParameter(param, tenv) {
	return {
		name: param.name,
		optional: param.optional,
		type: substType(param.type, tenv)
	}
}
function substCall(call, tenv) {
	var typeParamSubst = substTypeParameters(call.typeParameters, tenv)
	var typeParams = typeParamSubst.typeParams
	tenv = typeParamSubst.tenv
	return {
		new: call.new,
		variadic: call.variadic,
		typeParameters: typeParams,
		parameters: call.parameters.map(substParameter.fill(undefined, tenv)),
		returnType: substType(call.returnType, tenv),
		meta: call.meta
	}
}
function substPrty(prty, tenv) {
	return {
		optional: prty.optional,
		type: substType(prty.type, tenv),
		meta: prty.meta
	}
}
function substType(type, tenv) {
	switch (type.type) {
	case 'type-param':
		var t = tenv.get(type.name);
		if (t)
			return t;
		else
			return type; // this happens for function type params
	case 'object':
		return {
			type: 'object',
			typeParameters: [],
			properties: jsonMap(type.properties, substPrty.fill(undefined,tenv)),
			calls: type.calls.map(substCall.fill(undefined,tenv)),
			stringIndexer: type.stringIndexer && substType(type.stringIndexer, tenv),
			numberIndexer: type.numberIndexer && substType(type.numberIndexer, tenv),
			path: type.path,
			meta: type.meta
		}
		break;
	case 'reference':
		return {
			type: 'reference',
			name: type.name,
			typeArguments: type.typeArguments.map(substType.fill(undefined,tenv))
		}
	default:
		return type;
	}
}

// ---------------------------------
// 		 Type Canonicalization
// ---------------------------------

var canonical_cache = Object.create(null)
var canonical_next_number = 1;
function canonicalizeKey(key) {
	var value = canonical_cache[key]
	if (!value) {
		value = canonical_next_number++
		canonical_cache[key] = value
	}
	return value
}
function escapeStringConst(str) {
	return str; // todo, but only necessary in unrealistic circumstances
}
function canonicalizeValue(value) {
	switch (typeof value) {
		case 'function':
		case 'object':
			if (value === null)
				return '_';
			else
				return '#' + value.key;
		case 'boolean':
			return value ? 't' : 'f';
		case 'number':
			return 'n:' + value
		case 'string':
			return 'C:' + escapeStringConst(value) // note: intentionally coincide with string-const type
		case 'undefined':
			return 'u';
		default:
			throw new Error("unknown value " + util.inspect(value));
	}
}
function canonicalizeCall(call) {
	var buf = []
	if (call.new)
		buf.push('+new')
	if (call.variadic)
		buf.push('+var')
	buf.push('<')
	call.typeParameters.forEach(function(tp) {
		buf.push(tp.name)
		buf.push(',')
	})
	buf.push('>(')
	call.parameters.forEach(function(param) {
		buf.push(param.optional ? '?' : '')
		buf.push(canonicalizeType(param.type))
		buf.push(';')
	})
	buf.push(')')
	buf.push(canonicalizeType(call.returnType))
	var key = buf.join('')
	return canonicalizeKey(key)
}
function canonicalizeType(type) {
	switch (type.type) {
		case 'object':
			if (type.canonical_id)
				return type.canonical_id;
			var bag = []
			for (k in type.properties) {
				var prty = type.properties[k]
				bag.push(k + (prty.optional ? '?' : '') + ':' + canonicalizeType(prty.type))
			}
			type.calls.forEach(function(call) {
				bag.push('#' + canonicalizeCall(call))
			})
			if (type.stringIndexer)
				bag.push('[S]:' + canonicalizeType(type.stringIndexer))
			if (type.numberIndexer)
				bag.push('[N]:' + canonicalizeType(type.numberIndexer))
			var key = bag.sort().join(';')
			var id = canonicalizeKey(key);
			type.canonical_id = id;
			return id;
		case 'reference':
			if (type.typeArguments.length > 0) {
				var key = '@' + type.name + '<' + type.typeArguments.map(canonicalizeType).join(';') + '>'
				return canonicalizeKey(key)
			} else {
				return '@' + type.name;
			}
		case 'number':
			return 'N';
		case 'boolean':
			return 'B';
		case 'string':
			return 'S';
		case 'string-const':
			return 'C:' + escapeStringConst(type.value)
		case 'any':
			return 'A';
		case 'void':
			return 'V';
		case 'enum':
			return 'E:' + type.name;
		case 'value':
			return 'W:' + canonicalizeValue(type.value);
		case 'node':
			return 'X:' + type.node.rep().id
		case 'type-param':
			return 'T:' + type.name
		default:
			throw new Error("Unrecognized type: " + util.inspect(type))
	}
}

// ------------------------------------------------------------
// 		 Index Properties
// ------------------------------------------------------------

function indexProperties(obj) {
	if (!obj)
		return;
	if (obj.propertyMap)
		return;
	obj.propertyMap = new Map;
	obj.properties.forEach(function(prty) {
		obj.propertyMap.put(prty.name, prty);
	})
	if (!obj.prototype)
		return;
	var parent = lookupObject(obj.prototype.key);
	indexProperties(parent)
	parent.propertyMap.forEach(function(name,prty) {
		if (!obj.propertyMap.has(name)) {
			obj.propertyMap.put(name,prty);
		}
	})
}
onLoaded(function() {
	snapshot.heap.forEach(indexProperties);
})

function lookupPath(path, e) {
	e = e || function() { throw new Error("Missing value at " + path) }
	var value = {key: snapshot.global}
	var toks = path.split('.')
	for (var i=0; i<toks.length; i++) {
		var tok = toks[i];
		if (typeof value !== 'object') {
			return e(path);
		}
		var obj = lookupObject(value.key);
		var prty = obj.propertyMap.get(tok);
		if (!prty || !('value' in prty)) {
			return e(path);
		}
		value = prty.value;
	}
	return value;
}

// ------------------------------------------------------------
// 		 Determine Enum Values
// ------------------------------------------------------------

var enum_values = new Map;
function determineEnums() {
	for (var qname in typeDecl.enums) {
		var paths = typeDecl.enums[qname];
		var values = paths.map(lookupPath.fill(undefined, function(path) {
			console.log("Enum " + qname + " is missing value " + path)
			return null;
		}));
		enum_values.put(qname, values);
	}
}
onLoaded(determineEnums)

// ------------------------------------------------------------
// 		 ToObject Coercion
// ------------------------------------------------------------

onLoaded(function() {
	ObjectPrototype = lookupPath("Object.prototype");
	NumberPrototype = lookupPath("Number.prototype");
	StringPrototype = lookupPath("String.prototype");
	BooleanPrototype = lookupPath("Boolean.prototype");
	FunctionPrototype = lookupPath("Function.prototype");	
})

function coerceToObject(x) {
	switch (typeof x) {
		case 'number': return NumberPrototype;
		case 'string': return StringPrototype;
		case 'boolean': return BooleanPrototype;
		default: return x;
	}
}

function coerceTypeToObject(x) {
	switch (x.type) {
		case 'number': return {type: 'reference', name:'Number', typeArguments: []}
		case 'string': return {type: 'reference', name:'String', typeArguments: []}
		case 'string-const': return {type: 'reference', name:'String', typeArguments: []}
		case 'boolean': return {type: 'reference', name:'Boolean', typeArguments: []}
		case 'value':
			switch (typeof x) {
				case 'number': return {type: 'reference', name:'Number', typeArguments: []}
				case 'string': return {type: 'reference', name:'String', typeArguments: []}
				case 'boolean': return {type: 'reference', name:'Boolean', typeArguments: []}
				default: x
			}
		default: return x
	}
}


// ------------------------------------------------------------
// 		 Mark native functions with call signatures
// ------------------------------------------------------------

var native2callsigs = Object.create(null)
function markNatives() {
	var visited = Object.create(null)
	function visit(value,type) {
		if (value === null || typeof value !== 'object')
			return
		if (type.type === 'reference') {
			var h = canonicalizeType(type) + "~" + value.key
			if (h in visited)
				return
			visited[h] = true
			type = resolveTypeRef(type)
		}
		if (type.type !== 'object')
			return
		var obj = lookupObject(value.key)
		if (obj.function && obj.function.type === 'native') {
			var list = native2callsigs[obj.function.id]
			if (!list) {
				list = native2callsigs[obj.function.id] = []
			}
			type.calls.forEach(function(sig) {
				list.push(sig)
			})
		}
		for (var k in type.properties) {
			visitPrty(obj.propertyMap.get(k), type.properties[k].type)
		}
		if (type.numberIndexer) {
			obj.propertyMap.forEach(function(name,prty) {
				if (isNumberString(name))
					visitPrty(prty, type.numberIndexer)
			})
		}
		if (type.stringIndexer) {
			obj.propertyMap.forEach(function(name,prty) {
				if (prty.enumerable) {
					visitPrty(prty, type.stringIndexer)
				}
			})
		}
	}
	function visitPrty(prty,type) {
		if (prty && 'value' in prty) {
			visit(prty.value, type)
		}
	}
	visit({key: snapshot.global}, {type: 'reference', name: typeDecl.global, typeArguments:[]})
}
onLoaded(markNatives)

function getCallSigsForNative(key) {
	return native2callsigs[key] || []
}

// ------------------------------------------------------------
// 		 Recursive check of Value vs Type
// ------------------------------------------------------------

// True if `x` is the canonical representation of an integer (no leading zeros etc)
function isNumberString(x) {
	return x !== 'Infinity' && x !== 'NaN' && x === String(Math.floor(Number(x)))
}
// True if `x` can be converted to a number
function isNumberLikeString(x) {
	return x == 0 || !!Number(x)
}


var tpath2warning = new Map;
function reportError(msg, path, tpath) {
	var append = ''
	if (program.compact && tpath2warning.has(tpath)) {
		// append = ' [REPEAT]'
		return
	}
	tpath2warning.put(tpath, true)
	if (program.warn) {
		console.log((path || '<global>') + ": " + msg + append)
	}
}

var tpath2values = new Map;
var native_tpaths = new Map;
var assumptions = {}
function check(type, value, path, userPath, parentKey, tpath) {
	function must(condition) {
		if (!condition) {
			if (userPath) {
				reportError("expected " + formatType(type) + " but found value " + formatValue(value), path, tpath);
			}
			return false;
		} else {
			return true;
		}
	}
	if (!type) {
		throw new Error("Undefined type on path: " + path)
	}
	if (value === null) {
		return; // null satisfies all types
	}
	switch (type.type) {
		case 'object':
			if (!type.path) {
				console.log("Missing type path at value " + path)
			}
			tpath = type.path; // override tpath with object's own path
			tpath2values.push(type.path, value)
			if (!userPath) {
				native_tpaths.put(type.path, true)
			}
			value = coerceToObject(value);
			if (must(typeof value === 'object')) {
				var obj = lookupObject(value.key)
				if (checkCyclicPrototype(value.key)) {
					reportError("Cyclic prototype chain", path, tpath);
					return;
				}
				for (var k in type.properties) {
					var typePrty = type.properties[k]
					var isUserPrty = typePrty.meta.origin != LIB_ORIGIN;
					var isUserPath = userPath || isUserPrty;
					var objPrty = obj.propertyMap.get(k) //findPrty(obj, k)
					if (!objPrty) {
						if (!typePrty.optional && isUserPath) {
							var can_be_optional = type.meta.kind === 'interface'; // only interfaces can have optional members
							if (typePrty.type.type === 'boolean' && !can_be_optional) {
								// filter out warnings about absent boolean flags, where the flag cannot be declared optional
							} else {
								reportError("expected " + formatType(typePrty.type) + " but found nothing", qualify(path,k), qualify(tpath,k))
							}
						}
					} else {
						if ('value' in objPrty) {
							check(typePrty.type, objPrty.value, qualify(path,k), isUserPath, value.key, qualify(tpath,k))
						} else {
							if (objPrty.get) {
								var call = {
									new: false,
									variadic: false,
									typeParameters: [],
									parameters: [],
									returnType: typePrty.type,
									meta: {
										isGetter: true
									}
								}
								checkCallSignature(call, value.key, objPrty.get.key, qualify(path,k))
							}
							// todo: getters and setters require static analysis
						}
					}
				}
				if (type.stringIndexer && type.stringIndexer.type !== 'any') {
					obj.propertyMap.forEach(function(name,objPrty) {
						if (objPrty.enumerable && 'value' in objPrty) {
							check(type.stringIndexer, objPrty.value, path + '[\'' + name + '\']', userPath, value.key, tpath + '[string]')
						}
					})
				}
				if (type.numberIndexer && type.numberIndexer.type !== 'any') {
					obj.propertyMap.forEach(function(name,objPrty) {
						if (isNumberString(name) && 'value' in objPrty) {
							check(type.numberIndexer, objPrty.value, path + '[' + name + ']', userPath, value.key, tpath + '[number]')
						}
					})
				}
				if (userPath) {
					type.calls.forEach(function (call) {
						if (!call.meta.implicit) { // do not check default constructor
							checkCallSignature(call, parentKey, value.key, path)
						}
					})	
				}
				if (type.brand) {
					if (hasBrand(value, type.brand) === false) {
						reportError("missing prototype for branded type " + type.brand, path, tpath)
					}
				}
			}
			break;
		case 'reference':
			value = coerceToObject(value)
			if (!must(typeof value === 'object'))
				return; // only object types can match a reference
			var assumKey = value.key + '~' + canonicalizeType(type)
			if (assumptions[assumKey])
				return; // already checked or currently checking
			assumptions[assumKey] = true
			var objectType = lookupQType(type.name, type.typeArguments)
			if (!objectType)
				return; // error issued elsewhere
			check(objectType, value, path, userPath, parentKey, type.name)
			break;
		case 'enum':
			var vals = enum_values.get(type.name);
			if (vals.length === 0) {
				must(typeof value !== 'undefined');
			} else {
				must(vals.some(function(x) { return valuesStrictEq(x,value) }));
			}
			break;
		case 'string-const':
			must(typeof value === 'string' && value === type.value)
			break;
		case 'number':
			must(typeof value === 'number');
			break;
		case 'string':
			must(typeof value === 'string');
			break;
		case 'boolean':
			must(typeof value === 'boolean');
			break;
		case 'any':
			break; // no check necessary
		case 'void':
			must(typeof value === 'undefined');
			break;
		case 'type-param':
			// should be replaced by substType before we get here
			throw new Error("Checking value " + formatValue(value) + " against unbound type parameter " + type.name);
		default:
			throw new Error("Unrecognized type type: " + type.type + " " + util.inspect(type))
	}
}

function valuesStrictEq(x,y) {
	if (x === y)
		return true
	if (x && typeof x === 'object' && y && typeof y === 'object')
		return x.key === y.key
	return false
}

// Returns true if brand is satisfied, false if brand is not satisfied, or null if brand prototype could not be found.
function hasBrand(value, brand) {
	var ctor = lookupPath(brand, function() { return null })
	if (!ctor || typeof ctor !== 'object')
		return null;
	var proto = lookupObject(ctor.key).propertyMap.get('prototype')
	if (!proto || !proto.value || typeof proto.value !== 'object')
		return null;
	while (value && typeof value === 'object') {
		if (value.key === proto.value.key)
			return true
		value = lookupObject(value.key).prototype
	}
	return false;
}

var shared_analyzer;
function checkCallSignature(call, receiverKey, functionKey, path) {
	var functionObj = lookupObject(functionKey)
	if (!functionObj.function) {
		console.log(path + ": expected " + formatTypeCall(call) + " but found non-function object")
		return
	}
	if (functionObj.function.type === 'native')
		return // do not check natives
	var analyzer = new Analyzer
	// var analyzer = (shared_analyzer || (shared_analyzer = new Analyzer))
	var ok = analyzer.checkSignature(call, functionKey, receiverKey, path)

	analyzer = null
	runGC()
	// if (!ok) {
	// 	console.log(path + ": does not satisfy signature " + formatTypeCall(call))
	// }
	// if (!isCallSatisfiedByObject(call, {type: 'value', value: {key: receiverKey}}, functionKey)) {
	// 	console.log(path + ": does not satisfy signature " + formatTypeCall(call))
	// }
}

// --------------------
// 		Subtyping
// --------------------

var subtype_assumptions = Object.create(null);
function isSubtypeOf(x, y) { // x <: y
	switch (y.type) {
		case 'object':
			// x <: {..}
			x = coerceTypeToObject(x)
			if (x.type === 'reference') {
				x = lookupQType(x.name, x.typeArguments)
			}
			if (x.type !== 'object')
				return false;
			for (var k in y.properties) {
				if (!x.hasOwnProperty(k))
					return false
				if (x.properties[k].optional && !y.properties[k].optional) {
					return false // {f?:T} is not subtype of {f:T}
				}
				if (!isSubtypeOf(x.properties[k].type, y.properties[k].type)) {
					return false
				}
			}
			if (y.stringIndexer) {
				if (!x.stringIndexer)
					return false
				if (!isSubtypeOf(x.stringIndexer, y.stringIndexer))
					return false
			}
			if (y.numberIndexer) {
				if (!x.numberIndexer)
					return false
				if (!isSubtypeOf(x.numberIndexer, y.numberIndexer))
					return false
			}
			// TODO: call signatures?
			return true
		case 'reference':
			var key = canonicalizeType(x) + '~' + canonicalizeType(y)
			if (key in subtype_assumptions)
				return subtype_assumptions[key]
			subtype_assumptions[key] = true
			return subtype_assumptions[key] = isSubtypeOf(x, lookupQType(y.name, y.typeArguments))
		case 'enum':
			return (x.type === 'enum' && x.name === y.name)
		case 'string-const':
			return (x.type === 'string-const' && x.value === y.value)
		case 'number':
			return (x.type === 'number')
		case 'string':
			return (x.type === 'string' || x.type === 'string-const')
		case 'boolean':
			return (x.type === 'boolean')
		case 'any':
			return true;
		case 'void':
			return (x.type === 'void')
		case 'type-param':
			throw new Error("Checking subtype vs unbound type parameter: " + util.inspect(y))
		default:
			throw new Error("Unrecognized type type: " + y.type + " " + util.inspect(y))
	}
}

// --------------------------------------------
// 		Suggest Additions to the Interface     
// --------------------------------------------

var SkipFunctionPrtys = ['name', 'length', 'arguments', 'caller', 'callee', 'prototype'];

function skipPrty(obj, name) {
	if (obj.function) {
		if (SkipFunctionPrtys.some(name))
			return true; // don't suggest built-in properties
		var funProto = lookupObject(FunctionPrototype.key)
		if (funProto.propertyMap.has(name))
			return true; // don't suggest properties inherited from Function.prototype
	}
	if (name[0] === '_') // names starting with underscore are almost always private
		return true;
	return false;
}

function findSuggestions() {
	tpath2values.forEach(function(tpath, values) {
		if (native_tpaths.has(tpath))
			return;
		var type = tpath2type.get(tpath)
		if (!type) {
			console.log("Invalid tpath = " + tpath)
			return
		}
		var names = new Map
		values.forEach(function(value) {
			value = coerceToObject(value)
			if (typeof value !== 'object')
				return;
			var obj = lookupObject(value.key)
			obj.propertyMap.forEach(function(name,prty) {
				if (type.properties[name]) // ignore if type already declares this property
					return;
				if (type.stringIndexer && prty.enumerable) // property covered by string indexer
					return;
				if (type.numberIndexer && isNumberString(name)) // property covered by number indexer
					return;
				if (skipPrty(obj,name)) // uninteresting property
					return;
				names.increment(name)
			})
		})
		names.forEach(function(name,count) {
			var alwaysPresent = (count === values.length);
			var optStr = alwaysPresent ? '' : '(optional)';
			console.log(qualify(tpath,name) + ': missing from .d.ts ' + optStr)
		})
	})
}

// --------------------------------------------
// 		Coverage
// --------------------------------------------

var coverage = {
	types: {
		total: 0,
		used: 0
	},
	names: {
		total: 0,
		used: 0
	},
	reachable: {} // names of reachable types in type environment
}

function reachableCall(call) {
	call.typeParameters.forEach(function(tp) {
		if (tp.constraint)
			reachableType(tp.constraint)
	})
	call.parameters.forEach(function(p) {
		reachableType(p.type)
	})
	reachableType(call.returnType)
}
function reachableType(type) {
	switch (type.type) {
		case 'object':
			for (var k in type.properties) {
				reachableType(type.properties[k].type)
			}
			type.calls.forEach(reachableCall)
			if (type.stringIndexer)
				reachableType(type.stringIndexer)
			if (type.numberIndexer)
				reachableType(type.numberIndexer)
			break;
		case 'reference':
			type.typeArguments.forEach(reachableType)
			if (!coverage.reachable[type.name]) {
				coverage.reachable[type.name] = true;
				var t = typeDecl.env[type.name]
				if (t) {
					reachableType(t.object);
				}
			}
			break;
	}
}

function typeCoverageCall(call, r) {
	call.typeParameters.forEach(function(tp) {
		if (tp.constraint) {
			typeCoverage(tp.constraint, false);
		}
	})
	call.parameters.forEach(function(param) {
		typeCoverage(param.type, false);
	})
	typeCoverage(call.returnType, false);
}

function typeCoverage(type, r) {
	if (type.type === 'object' && type.meta.origin == LIB_ORIGIN)
		return; // don't measure coverage inside lib.d.ts
	coverage.types.total++;
	switch (type.type) {
		case 'object':
			r = !!tpath2values.get(type.path);
			if (r)
				coverage.types.used++;
			for (var k in type.properties) {
				if (type.properties[k].meta.origin != LIB_ORIGIN) {
					coverage.names.total++;
					if (r) {
						coverage.names.used++;
					}
				}
				typeCoverage(type.properties[k].type, r);
			}
			// we don't measure call signatures in this statistic
			// type.calls.forEach(function(call) {
			// 	typeCoverageCall(call, r);
			// })
			if (type.stringIndexer)
				typeCoverage(type.stringIndexer, r);
			if (type.numberIndexer)
				typeCoverage(type.numberIndexer, r);
			break;
		case 'reference':
			type.typeArguments.forEach(function(t) {
				typeCoverage(t, r);
			})
			break;
		default:
			if (r) {
				coverage.types.used++;
			}
	}
}

function printCoverage() {
	// Find reachable types
	coverage.reachable[typeDecl.global] = true;
	reachableType(typeDecl.env[typeDecl.global].object);

	// Find type expressions checked by our procedure
	for (var k in typeDecl.env) {
		if (!coverage.reachable[k])
			continue; // don't measure coverage for unused type definitions, it is meaningless to look for bugs in those
		typeCoverage(typeDecl.env[k].object, false);
	}
	function percent(x,y) {
		if (y === 0)
			y = 1;
		return (100 * x / y);
	}
	function str(cov) {
		return cov.used + " / " + cov.total + " (" + percent(cov.used,cov.total).toFixed(2) + "%)";
	}
	console.log("TYPE COVERAGE " + str(coverage.types));
	console.log("NAME COVERAGE " + str(coverage.names));
}

// ------------------------------------------
// 		Formatting types and values          
// ------------------------------------------

// TODO: restrict depth to avoid printing gigantic types

function formatTypeProperty(name,prty) {
	return name + (prty.optional ? '?' : '') + ': ' + formatType(prty.type)
}
function formatTypeParameter(tparam) {
	return tparam.name;
}
function formatTypeCall(call) {
	var newstr = call.new ? 'new' : '';
	var tparams = call.typeParameters.length === 0 ? '' : ('<' + call.typeParameters.map(formatTypeParameter).join(',') + '>')
	return newstr + tparams + '(' + call.parameters.map(formatParameter).join(', ') + ') => ' + formatType(call.returnType)
}
function formatParameter(param) {
	return param.name + (param.optional ? '?' : '') + ':' + formatType(param.type)
}

function formatType(type) {
	switch (type.type) {
		case 'object':
			var members = []
			for (var k in type.properties) {
				var prty = type.properties[k];
				members.push(k + (prty.optional ? '?' : '') + ': ' + formatType(prty.type))
			}
			members = members.concat(type.calls.map(formatTypeCall));
			return '{' + members.join(', ') + '}'
		case 'reference':
			if (type.typeArguments.length > 0)
				return type.name + '<' + type.typeArguments.map(formatType).join(', ') + '>'
			else
				return type.name;
		case 'type-param':
			return type.name;
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
		case 'string-const':
			return '"' + type.value + '"';
		case 'enum':
			return type.name;
		case 'value':
			return 'value ' + formatValue(type.value)
		case 'node':
			return '#' + type.name
	}
	return util.inspect(type)
}
function formatValue(value, depth) {
	if (typeof depth === 'undefined')
		depth = 1;
	if (typeof value === 'object' && value !== null) {
		switch (value.key) {
			case ObjectPrototype.key: 	return "Object.prototype"
			case FunctionPrototype.key: return "Function.prototype"
			case StringPrototype.key: 	return "String.prototype"
			case NumberPrototype.key: 	return "Number.prototype"
			case BooleanPrototype.key: 	return "Boolean.prototype"
			case snapshot.global: 		return "<global>"
			default:
				var obj = lookupObject(value.key)
				if (depth <= 0)
					return obj.function ? '[Function]' : '[Object]'
				var fn = obj.function ? 'Function ' : ''
				return fn + '{ ' + obj.properties.map(function(prty) { return prty.name + ': ' + formatValue(prty.value,depth-1) }).join(', ') + ' }'
		}
	} else {
		return util.inspect(value)
	}
}


// ----------------------
// 		HASH SETS
// ----------------------

function HashSet() {
}
HashSet.prototype.add = function(x) {
	var h = this.hash(x)
	if (h in this)
		return false
	this[h] = x
	return true
}
HashSet.prototype.has = function(x) {
	return this.hash(x) in this
}
HashSet.prototype.some = function(fn) {
	for (var k in this) {
		if (this.hasOwnProperty(k)) {
			if (fn(this[k])) {
				return true
			}
		}
	}
	return false
}
HashSet.prototype.all = function(fn) {
	for (var k in this) {
		if (this.hasOwnProperty(k)) {
			if (!fn(this[k])) {
				return false
			}
		}
	}
	return true
}
HashSet.prototype.forEach = function(fn) {
	for (var k in this) {
		if (this.hasOwnProperty(k)) {
			fn(this[k])
		}
	}
}
HashSet.prototype.addAll = function(ts) {
	var ch = false
	for (var k in ts) {
		if (!(k in this)) {
			this[k] = ts[k]
			ch = true
		}
	}
	return ch
}
HashSet.prototype.clone = function() {
	var r = Object.create(Object.getPrototypeOf(this))
	for (var k in this) {
		if (this.hasOwnProperty(k)) {
			r[k] = this[k]
		}
	}
	return r
}
HashSet.prototype.isEmpty = function() {
	for (var k in this) {
		if (this.hasOwnProperty(k))
			return false
	}
	return true
}
HashSet.prototype.first = function() {
	for (var k in this) {
		if (this.hasOwnProperty(k))
			return this[k]
	}
	return null
}

function TypeSet() {}
TypeSet.prototype = Object.create(HashSet.prototype)
TypeSet.prototype.hash = canonicalizeType

function ValueSet() {}
ValueSet.prototype = Object.create(HashSet.prototype)
ValueSet.prototype.hash = canonicalizeValue

function canonicalizeFunction(fun) {
	switch (fun.type) {
		case 'user':
			return 'U' + fun.id
		case 'native':
			return 'N' + fun.id
		case 'bind':
			return 'B' + canonicalizeValue(fun.target) + '^' + fun.arguments.map(canonicalizeValue).join('^')
		case 'unknown':
			return 'U'
	}
}
function FunctionSet() {}
FunctionSet.prototype = Object.create(HashSet.prototype)
FunctionSet.prototype.hash = canonicalizeFunction

function CallSigSet() {}
CallSigSet.prototype = Object.create(HashSet.prototype)
CallSigSet.prototype.hash = canonicalizeCall


// --------------------------
// 		Static Analysis
// --------------------------


// Returns the given AST node's immediate children as an array.
// Property names that start with $ are considered annotations, and will be ignored.
function children(node) {
    var result = [];
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            continue;
        var val = node[k];
        if (!val)
            continue;
        if (typeof val === "object" && typeof val.type === "string") {
            result.push(val);
        }
        else if (val instanceof Array) {
            for (var i=0; i<val.length; i++) {
                var elm = val[i];
                if (typeof elm === "object" && typeof elm.type === "string") {
                    result.push(elm);
                }
            }
        } 
    }
    return result;
}

// Assigns parent pointers to each node. The parent pointer is called $parent.
function injectParentPointers(node, parent) {
    node.$parent = parent;
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        injectParentPointers(list[i], node);
    }
}

// Returns the function or program immediately enclosing the given node, possibly the node itself.
function getEnclosingFunction(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Returns the function, program or catch clause immediately enclosing the given node, possibly the node itself.
function getEnclosingScope(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'CatchClause' &&
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Injects an the following into functions, programs, and catch clauses
// - $env: Map from variable names in scope to Identifier at declaration
// - $depth: nesting depth from top-level
function injectEnvs(node) {
    switch (node.type) {
        case 'Program':
            node.$env = new Map;
            node.$depth = 0;
            break;
        case 'FunctionExpression':
            node.$env = new Map;
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            if (node.id) {
                node.$env.put(node.id.name, node.id)
            }
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            node.$env.put('arguments', node)
            break;
        case 'FunctionDeclaration':
            var parent = getEnclosingFunction(node.$parent); // note: use getEnclosingFunction, because fun decls are lifted outside catch clauses
            node.$env = new Map;
            node.$depth = 1 + parent.$depth;
            parent.$env.put(node.id.name, node.id)
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            node.$env.put('arguments', node)
            break;
        case 'CatchClause':
            node.$env = new Map;
            node.$env.put(node.param.name, node.param)
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            break;
        case 'VariableDeclarator':
            var parent = getEnclosingFunction(node) // note: use getEnclosingFunction, because vars ignore catch clauses
            parent.$env.put(node.id.name, node.id)
            break;
    }
    children(node).forEach(injectEnvs)
}


function numberASTNodes(ast) {
	var functions = []
	var next_id = 0
	function visit(node) {
		node.$id = ++next_id
		if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'Program') {
			node.$function_id = functions.length
			functions.push(node)
		}
		children(node).forEach(visit)
	}
	visit(ast)
	ast.$id2function = functions
}

function getFunction(id) {
	var f = sourceFileAst.$id2function[id]
	if (!f) {
		console.error("Missing function with ID " + id)
	}
	return f
}

function prepareAST(ast) {
	numberASTNodes(ast)
	injectParentPointers(ast)
	injectEnvs(ast)
}

onLoaded(function() {
	if (sourceFileAst) {
		prepareAST(sourceFileAst)
	}	
})

var graphvizCounter = 0;
function Analyzer() {
	var queue = []

	// DEBUGGING MATERIALS
	var graphviz = new Graphviz
	var graphviz_functions = []
	var graphviz_nodes = []
	function includeFunctionInGraphviz(x) {
		graphviz_functions.push(x)
	}
	function includeNodeInGraphviz(x) {
		graphviz_nodes.push(x)
	}

	//////////////////////////
	// 		UNIFICATION		//
	//////////////////////////
	var current_clone_phase = 0;
	function beginClone() {
		if (queue.length > 0)
			throw new Error("Must complete worklist before cloning!")
		current_clone_phase++
	}
	function endClone() {
	}

	var all_unodes = []
	var unode_id = 0
	function UNode() {
		// all_unodes.push(this) // TODO: remove when not debuggin

		// union-find information
		this.parent = this
		this.rank = 0
		// cloning information
		this.clone_phase = -1
		this.clone_target = null
		this.global = false
		// attributes
		this._id = ++unode_id
		this._properties = new SMap
		this._primitives = new TypeSet
		this._functions = new FunctionSet
		this._call_sigs = new CallSigSet
		this._resolved_refs = new TypeSet
		this._prototypes = []
		this._isAny = false
		this._isObject = false
	}
	UNode.prototype = {
		get id() { return this.rep()._id },
		get properties() { return this.rep()._properties },
		get primitives() { return this.rep()._primitives },
		get functions() { return this.rep()._functions },
		get call_sigs() { return this.rep()._call_sigs },
		get resolved_refs() { return this.rep()._resolved_refs },
		get prototypes() { return this.rep()._prototypes },
		get isAny() { return this.rep()._isAny },
		set isAny(x) { this.rep()._isAny = x },
		get isObject() { return this.rep()._isObject },
		set isObject(x) { this.rep()._isObject = x }
	}
	UNode.prototype.rep = function() {
		var p = this.parent
		if (p === this)
			return p
		return this.parent = p.rep()
	};
	UNode.prototype.getPrty = function(name) {
		var r = this.rep()
		var wasEmpty = r.properties.size === 0
		var p = r.properties.get(name)
		var n;
		if (!p) {
			n = new UNode
			r.properties.put(name, {type: 'node', node: n})
			n.isAny = r.isAny
			n.global = r.global
		} else if (p.type === 'node') {
			n = p.node
		} else {
			n = new UNode
			p.types.forEach(function(t) {
				n.addType(t)
			})
			n.isAny = r.isAny
			n.global = r.global
			r.properties.put(name, {type: 'node', node: n})
		}
		// if this is the first time the node is being used as an object, add the relevant coerced types
		if (wasEmpty) {
			r.primitives.forEach(function(t) {
				var coerced = primitiveToObjectType(t)
				if (coerced) {
					r.addType(coerced)
				}
			})
		}
		return n
	}
	UNode.prototype.clone = function() {
		var r = this.rep()
		if (r.global) {
			return r
		} else if (r.clone_phase === current_clone_phase) {
			return r.clone_target
		} else {
			r.clone_phase = current_clone_phase
			var target = r.clone_target = new UNode
			target._primitives = r.primitives.clone()
			target._functions = r.functions.clone()
			target._call_sigs = r.call_sigs.clone()
			target._resolved_refs = r._resolved_refs.clone()
			target._prototypes = r._prototypes.map(function(x) { return x.clone() })
			target._isObject = r.isObject
			target._isAny = r.isAny
			r.properties.forEach(function(name,dst) {
				if (dst.type === 'node')
					target.properties.put(name, {type: 'node', node: dst.node.clone()})
				else
					target.properties.put(name, {type: 'union', types: dst.types.clone()})
			})
			return target
		}
	}
	UNode.prototype.makeAny = function() {
		var r = this.rep()
		if (r.isAny)
			return
		r.isAny = true
		r.properties.forEach(function(name,dst) {
			if (dst.type === 'node')
				dst.node.makeAny()
		})
	}
	UNode.prototype.makeGlobal = function() {
		var r = this.rep()
		if (r.global)
			return
		r.global = true
		r.properties.forEach(function(name,dst) {
			if (dst.type === 'node')
				dst.node.makeGlobal()
		})
	}
	function primitiveToObjectType(t) {
		var typ = t.type === 'value' ? (typeof t.value) : t.type
		switch (typ) {
			case 'number':
				return {type: 'reference', name:'Number', typeArguments:[]}
			case 'string':
			case 'string-const':
				return {type: 'reference', name:'String', typeArguments:[]}
			case 'boolean':
				return {type: 'reference', name:'Boolean', typeArguments:[]}
			default:
				return null
		}
	}
	UNode.prototype.addType = function(t) {
		var self = this
		if (this.parent !== this) {
			this.rep().addType(t)
			return
		}
		switch (t.type) {
			case 'node':
				unifyLater(this, t.node)
				break;
			case 'any':
				this.makeAny();
				break;
			case 'reference':
				if (this.resolved_refs.add(t)) {
					this.addType(resolveTypeRef(t))
				}
				break;
			case 'object':
				this.isObject = true
				for (var k in t.properties) {
					var dst = this.properties.get(k)
					if (dst) {
						if (dst.type === 'node') {
							dst.node.addType(t.properties[k].type)
						} else if (dst.type === 'union') {
							dst.types.add(t.properties[k].type)
						} else {
							throw new Error("Unexpected property type: " + util.inspect(dst))
						}
					} else {
						var ut = {
							type: 'union',
							types: new TypeSet
						}
						ut.types.add(t.properties[k].type)
						this.properties.put(k, ut)
					}
				}
				t.calls.forEach(function(call) {
					self.call_sigs.add(call)
				})
				// TODO: indexers, brands
				break;
			case 'number':
			case 'string':
			case 'boolean':
			case 'void':
			case 'value':
				this.primitives.add(t)
				break;
			case 'string-const':
				this.primitives.add({type: 'value', value: t.value})
				break;
			case 'enum':
				this.makeAny(); // TODO: proper handling of enums
				break;
			default:
				throw new Error("Unexpected type: " + t.type)
		}
		// whenever we add a primitive type to a node that is being used as an object, also add its coerced type
		if (this.properties.size > 0) {
			var coerced = primitiveToObjectType(t)
			if (coerced) {
				this.addType(coerced)
			}	
		}
	}

	function unifyNow(n1, n2) {
		n1 = n1.rep()
		n2 = n2.rep()
		if (n1 === n2)
			return

		if (n2.isAny && !n1.isAny) {
			n1.makeAny()
		}
		else if (n1.isAny && !n2.isAny) {
			n2.makeAny()
		}
		if (n2.global && !n1.global) {
			n1.makeGlobal()
		}
		else if (n1.global && !n2.global) {
			n2.makeGlobal()
		}

		if (n2.rank > n1.rank) {
			var z = n1; n1 = n2; n2 = z; // swap n1/n2 so n1 has the highest rank
		}
		if (n1.rank === n2.rank) {
			n1.rank++
		}
		n2.parent = n1
		
		// merge properties
		var big, small;
		if (n1._properties.size >= n2._properties.size) {
			big = n1._properties
			small = n2._properties
		} else {
			big = n2._properties
			small = n1._properties
			n1._properties = big
		}
		for (var k in small) {
			if (k[0] !== '$')
				continue
			var p2 = small[k]
			if (k in big) {
				var p1 = big[k]
				if (p1.type === 'node') {
					if (p2.type === 'node') {
						unifyLater(p1.node, p2.node)
					} else {
						p2.types.forEach(function(t) {
							addTypeLater(p1.node, t)
						})
					}
				} else {
					if (p2.type === 'node') {
						big[k] = p2
						p1.types.forEach(function(t) {
							addTypeLater(p2.node, t)
						})
					} else {
						p1.types.addAll(p2.types)
					}
				}
			} else {
				big[k] = p2
				big.size++
			}
		}

		// merge other attributes
		n1._id = Math.min(n1._id, n2._id)
		n1._functions.addAll(n2._functions)
		n1._primitives.addAll(n2._primitives)
		n1._call_sigs.addAll(n2._call_sigs)
		n1._resolved_refs.addAll(n2._resolved_refs)
		n1._prototypes = mergeArrays(n1._prototypes, n2._prototypes)
		n1._isObject |= n2._isObject
		n1._isAny |= n2._isAny
		n1.global |= n2.global

		// clean up
		n2._functions = null
		n2._primitives = null
		n2._call_sigs = null
	}

	function mergeArrays(xs, ys) {
		return xs.concat(ys) // TODO: faster destructive merge
	}

	function addTypeLater(node, type) {
		queue.push(type)
		queue.push(node)
	}

	function unifyLater(n1, n2) {
		if (n1 !== n2) {
			queue.push(n1)
			queue.push(n2)
		}
	}

	function complete() {
		while (queue.length > 0) {
			var x = queue.pop()
			var y = queue.pop()
			if (y instanceof UNode) {
				unifyNow(x, y)
			} else {
				x.addType(y)
			}
		}
	}

	//////////////////////////////
	// 		FUNCTION NODE		//
	//////////////////////////////
	function FunctionNode() {
		this.arguments = new UNode
		this.return = new UNode
		this.this = new UNode
		this.self = new UNode
		this.calls = []
		this.inherits = []
		this.dynamic_accesses = []
	}
	FunctionNode.prototype.clone = function() {
		var fnode = Object.create(FunctionNode.prototype)
		fnode.arguments = this.arguments.clone()
		fnode.return = this.return.clone()
		fnode.this = this.this.clone()
		fnode.self = this.self.clone()
		fnode.calls = this.calls.map(function(x) { return x.clone() })
		fnode.inherits = this.inherits.map(function(x) { return x.clone() })
		fnode.dynamic_accesses = this.dynamic_accesses.map(function(x) { return x.clone() })
		return fnode
	}

	function CallNode(flags) {
		this.arguments = new UNode
		this.return = new UNode
		this.this = new UNode
		this.self = new UNode
		this.resolved_sigs = new CallSigSet
		this.new = flags.new || false
		this.context = flags.context
		if (!this.context)
			throw new Error("CallNode missing context")
		this.secondary = null
	}
	CallNode.prototype.clone = function() {
		var call = Object.create(CallNode.prototype)
		call.arguments = this.arguments.clone()
		call.return = this.return.clone()
		call.this = this.this.clone()
		call.self = this.self.clone()
		call.new = this.new
		call.context = this.context
		call.resolved_sigs = this.resolved_sigs.clone()
		return call
	}

	function DynamicAccessNode(object, property, value) {
		this.object = object
		this.property = property
		this.value = value
	}
	DynamicAccessNode.prototype.clone = function() {
		return new DynamicAccessNode(this.object.clone(), this.property.clone(), this.value.clone())
	}

	var ENV = '@env' // we hijack this property name for use as environment pointers (TODO: avoid name clash)
	
	var unresolved_calls = []
	function resolveCallLater(call) {
		unresolved_calls.push(call)
	}
	var unresolved_inherits = []
	function resolveInheritLater(node) {
		unresolved_inherits.push(node)
	}
	var unresolved_dynamic_accesses = []
	function resolveDynamicAccessLater(dnode) {
		unresolved_dynamic_accesses.push(dnode)
	}

	//////////////////////////////////////
	//			HEAP -> U-NODES 		//
	//////////////////////////////////////
	var object2node = Object.create(null)
	function getConcreteObject(key) {
		return object2node[key].rep()
	}
	function buildHeap() {
		snapshot.heap.forEach(function(obj,i) {
			if (!obj)
				return
			var n = object2node[i] = new UNode
			n.isObject = true
			n.global = true
			if (obj.function) {
				if (obj.function.type === 'user' && !obj.function.id) {
					console.error(util.inspect(obj))
				}
				n.functions.add(obj.function)
			}
		})
		snapshot.heap.forEach(function(obj,i) {
			if (!obj)
				return
			var n = object2node[i].rep()
			if (obj.env) {
				// console.log("Unifying environment")
				includeNodeInGraphviz(n)
				unifyNow(n.getPrty(ENV), getConcreteObject(obj.env.key))
			}
			obj.propertyMap.forEach(function(name,prty) {
				n = n.rep()
				if ('value' in prty) {
					if (prty.value && typeof prty.value === 'object') {
						n.properties.put(name, {type: 'node', node: object2node[prty.value.key]})
					} else {
						n.getPrty(name).primitives.add({type: 'value', value:prty.value})
					}
				} else {
					if (prty.get) {
						var call = new CallNode({context: '#' + i})
						unifyNow(call.self, getConcreteObject(prty.get.key))
						unifyNow(call.return, n.getPrty(name))
						unifyNow(call.this, n)
						resolveCallLater(call)
					}
					if (prty.set) {
						var call = new CallNode({context: '#' + i})
						unifyNow(call.self, getConcreteObject(prty.set.key))
						unifyNow(call.arguments.getPrty("0"), n.getPrty(name))
						unifyNow(call.this, n)
						resolveCallLater(call)
					}
				}
			})
		})
		complete()
	}
	function getNodeForValue(value) {
		if (value && typeof value === 'object')
			return getConcreteObject(value.key)
		else {
			var node = new UNode
			node.primitives.add({type:'value', value:value})
			return node
		}
	}
	buildHeap() 

	//////////////////////////////
	// 		AST -> U-NODES		//
	//////////////////////////////
	var function2fnode = Object.create(null)
	function getPristineFunctionNode(fun) {
		var fnode = function2fnode[fun.$id]
		if (!fnode) {
			fnode = function2fnode[fun.$id] = makeFunction(fun)
		}
		return fnode
	}
	function makeFunction(fun) { // ast-node -> FunctionNode
		var ast2node = Object.create(null)
		function getNode(x) {
			if (x instanceof UNode)
				return x.rep()
			var n = ast2node[x.$id]
			if (n) {
				return n.rep()
			} else {
				return ast2node[x.$id] = new UNode
			}
		}
		function unify(x) {
			x = getNode(x)
			for (var i=1; i<arguments.length; i++) {
				unifyNow(x, getNode(arguments[i]))
			}
		}
		function assumeType(x, t) {
			getNode(x).primitives.add(t)
		}
		function assumeAny(x) {
			getNode(x).makeAny()
		}

		var fnode = new FunctionNode
		var env = new UNode
		unify(env.getPrty(ENV), fnode.self.getPrty(ENV))

		fnode.env = env // FIXME: remove when not debugging

		if (fun.type === 'FunctionExpression' && fun.id) {
			unify(env.getPrty(fun.id.name), fnode.self)
		}
		unify(env.getPrty("arguments"), fnode.arguments)
		for (var i=0; i<fun.params.length; i++) {
			unify(fnode.arguments.getPrty(String(i)), env.getPrty(fun.params[i].name))
		}

		function addCall(call) {
			fnode.calls.push(call)
		}

		function getVar(id) {
			var scope = getEnclosingScope(id)
			while (scope !== fun && !scope.$env.has(id.name)) {
				scope = getEnclosingScope(scope.$parent)
			}
			if (scope.type === 'CatchClause')
				return getNode(scope).getPrty(param)
			var n = env
			while (scope.type !== 'Program' && !scope.$env.has(id.name)) {
				n = n.getPrty(ENV)
				scope = getEnclosingScope(scope.$parent)
			}
			return n.getPrty(id.name)
		}

		function addNodePrototype(n, proto) {
			n = getNode(n)
			n.prototypes.push(getNode(proto))
			fnode.inherits.push(n)
		}
		function addNativePrototype(n, path) {
			addNodePrototype(n, getConcreteObject(lookupPath(path).key))
		}
		function addDynamicAccess(object, property, value) {
			fnode.dynamic_accesses.push(new DynamicAccessNode(getNode(object), getNode(property), getNode(value)))
		}

		var NULL = 'NULL' // result of expression is null or undefined
		var NOT_NULL = 'NOT_NULL'
		var VOID = 'VOID' // result of expression is discarded or immediately coerced to a boolean
		var NOT_VOID = 'NOT_VOID'

		function visitStmt(node) {
			switch (node.type) {
				case 'EmptyStatement':
					break;
				case 'BlockStatement':
					node.body.forEach(visitStmt)
					break;
				case 'ExpressionStatement':
					visitExpVoid(node.expression)
					break;
				case 'IfStatement':
					visitExpVoid(node.test)
					visitStmt(node.consequent)
					if (node.alternate) {
						visitStmt(node.alternate)
					}
					break;
				case 'LabeledStatement':
					visitStmt(node.body)
					break;
				case 'BreakStatement':
					break;
				case 'ContinueStatement':
					break;
				case 'WithStatement':
					visitExp(node.object, NOT_VOID)
					visitStmt(node.body) // TODO: flag use of `with` and don't report errors from this function
					break;
				case 'SwitchStatement':
					visitExp(node.discriminant, NOT_VOID)
					node.cases.forEach(function(c) {
						if (c.test) {
							visitExpVoid(c.test, NOT_VOID)
						}
						c.consequent.forEach(visitStmt)
					})
					break;
				case 'ReturnStatement':
					if (node.argument) {
						visitExp(node.argument, NOT_VOID)
						unify(fnode.return, node.argument)
					} else {
						assumeType(fnode.return, {type:'value', value:undefined})
					}
					break;
				case 'ThrowStatement':
					visitExpVoid(node.argument)
					break;
				case 'TryStatement':
					visitStmt(node.block)
					if (node.handler) {
						assumeAny(node.handler.param)
						visitStmt(node.handler.body)
						var catchEnv = getNode(node.handler)
						var scope = getEnclosingScope(node)
						if (scope.type === 'CatchClause') {
							unify(catchEnv.getPrty(ENV), getNode(scope))
						} else {
							unify(catchEnv.getPrty(ENV), env)
						}
					}
					if (node.finalizer) {
						visitStmt(node.finalizer)
					}
					break;
				case 'WhileStatement':
					visitExpVoid(node.test)
					visitStmt(node.body)
					break;
				case 'DoWhileStatement':
					visitStmt(node.body)
					visitExpVoid(node.test)
					break;
				case 'ForStatement':
					if (node.init) {
						if (node.init.type === 'VariableDeclaration') {
							visitStmt(node.init)
						} else {
							visitExpVoid(node.init)
						}
					}
					if (node.test) {
						visitExpVoid(node.test)
					}
					if (node.update) {
						visitExpVoid(node.update)
					}
					visitStmt(node.body)
					break;
				case 'ForInStatement':
					var lv;
					if (node.left.type === 'VariableDeclaration') {
						visitStmt(node.left)
						lv = node.left.declarations[0].id
					} else {
						visitExpVoid(node.left)
						lv = node.left
					}
					assumeType(lv, {type: 'string'})
					visitStmt(node.body)
					break;
				case 'DebuggerStatement':
					break;
				case 'FunctionDeclaration':
					unify(node, node.id, env.getPrty(node.id.name)) // make accessible via variable name
					getNode(node).isObject = true // mark as object
					unify(getNode(node).getPrty(ENV), env) // make the active environment the new function's outer environment
					getNode(node).functions.add({type: 'user', id: node.$function_id})
					break;
				case 'VariableDeclaration':
					node.declarations.forEach(function(d) {
						unify(getVar(d.id), d.id)
						if (d.init) {
							var p = visitExp(d.init, NOT_VOID)
							if (p === NOT_NULL) {
								unify(d.id, d.init)
							}
						}
					})
					break;
				default:
					throw new Error("Unknown statement: " + node.type)
			}
		}
		function visitExpVoid(node) {
			return visitExp(node, VOID)
		}
		function visitExp(node, void_ctx) {
			switch (node.type) {
				case 'ArrayExpression':
					var n = getNode(node)
					n.isObject = true
					node.elements.forEach(function(elm, i) {
						if (!elm)
							return
						visitExp(elm, NOT_VOID)
						n = n.rep()
						unify(elm, n.getPrty(String(i)))
					})
					addNativePrototype(n, "Array.prototype")
					return NOT_NULL
				case 'ObjectExpression':
					getNode(node).isObject = true
					node.properties.forEach(function(p) {
						visitExp(p.value, NOT_VOID)
						var name = p.key.type === 'Literal' ? String(p.key.value) : p.key.name
						switch (p.kind) {
							case 'init':
								unify(getNode(node).getPrty(name), p.value)
								break;
							case 'get':
								unify(node, getThis(p.value))
								unify(getNode(node).getPrty(name), getReturn(p.value))
								break;
							case 'set':
								unify(node, getThis(p.value))
								if (p.value.params.length >= 1) {
									unify(getNode(node).getPrty(name), p.value.params[0])
								}
								break;
						}
					})
					addNativePrototype(node, "Object.prototype")
					return NOT_NULL
				case 'FunctionExpression':
					var scope = getEnclosingScope(node)
					if (scope.type === 'CatchClause') {
						unify(getNode(node).getPrty(ENV), scope)
					} else {
						unify(getNode(node).getPrty(ENV), env)
					}
					getNode(node).isObject = true
					getNode(node).functions.add({type: 'user', id: node.$function_id})
					return NOT_NULL
				case 'SequenceExpression':
					for (var i=0; i<node.expressions.length-1; ++i) {
						visitExpVoid(node.expressions[i])
					}
					unify(node, node.expressions.last())
					return visitExp(node.expressions.last(), void_ctx)
				case 'UnaryExpression':
					switch (node.operator) {
						case '+':
						case '~':
						case '-':
							visitExp(node.argument, NOT_VOID)
							assumeType(node, {type: 'number'})
							break;
						case '!':
							visitExp(node.argument, VOID)
							assumeType(node, {type: 'boolean'})
							break;
						case 'void':
							visitExp(node.argument, VOID)
							assumeType(node, {type: 'value', value: undefined})
							return NULL
						case 'typeof':
							visitExp(node.argument, VOID)
							assumeType(node, {type: 'string'})
							break;
						case 'delete':
							visitExp(node.argument, VOID)
							assumeType(node, {type: 'boolean'})
							break;
						default:
							throw new Error("Unknown unary operator: " + node.operator)
					}
					return NOT_NULL
				case 'BinaryExpression':
					visitExpVoid(node.left, NOT_VOID)
					visitExpVoid(node.right, NOT_VOID)
					switch (node.operator) {
						case "==":
						case "!=":
						case "===":
						case "!==":
					    case "<":
					    case "<=":
					    case ">":
					    case ">=":
					    case "in":
					    case "instanceof":
					    	assumeType(node, {type: 'boolean'})
					    	break;

					    case "<<":
					    case ">>":
					    case ">>>":
					    case "-":
					    case "*":
					    case "/":
					    case "%":
					    case "|":
					    case "^":
					    case "&":
					    	assumeType(node, {type: 'number'})
					    	break;

					    case "+": // could be either number or string (TODO: handle this more precisely, maybe by unification?)
					    	assumeType(node, {type: 'string'})
					    	assumeType(node, {type: 'number'})
					    	break;

					    default:
					    	throw new Error("Unknown binary operator: " + node.operator)
					}
					return NOT_NULL
				case 'AssignmentExpression':
					if (node.operator === '=') {
						visitExp(node.left, NOT_VOID)
						var r = visitExp(node.right, NOT_VOID)
						if (r !== NULL) {
							unify(node, node.left, node.right)
						}
						return r
					} else {
						visitExp(node.left, NOT_VOID)
						visitExp(node.right, NOT_VOID)
						unify(node, node.left)
						switch (node.operator) {
							case "+=":
								unify(node, node.left, node.right)
								break;
							case "-=":
							case "*=":
							case "/=":
							case "%=":
							case "<<=":
							case ">>=" :
							case ">>>=":
							case "&=":
							case "|=":
							case "^=":
								assumeType(node, {type: 'number'})
								break;
							default:
								throw new Error("Unknown compound assignment operator: " + node.operator)
						}
						return NOT_NULL
					}
				case 'UpdateExpression':
					visitExp(node.argument, NOT_VOID)
					assumeType(node, {type: 'number'})
					return NOT_NULL
				case 'LogicalExpression':
					if (node.operator === '&&') {
						unify(node, node.right)
						visitExp(node.left, VOID)
						visitExp(node.right, void_ctx)
						return NOT_NULL
					} else {
						if (void_ctx !== VOID) {
							unify(node, node.left, node.right)
						}
						visitExp(node.left, void_ctx)
						visitExp(node.right, void_ctx)
						return NOT_NULL
					}
				case 'ConditionalExpression':
					visitExp(node.test, VOID)
					visitExp(node.consequent, void_ctx)
					visitExp(node.alternate, void_ctx)
					if (void_ctx !== VOID) {
						unify(node, node.consequent, node.alternate)
					}
					return NOT_NULL
				case 'NewExpression':
					var call = new CallNode({new: true, context: 'node_' + node.$id})
					visitExp(node.callee)
					unify(call.self, node.callee)
					for (var i=0; i<node.arguments.length; i++) {
						visitExp(node.arguments[i])
						unify(call.arguments.getPrty(String(i)), node.arguments[i])
					}
					unify(call.this, node)
					addCall(call)
					call.this.rep().isObject = true
					addNodePrototype(call.this, getNode(node.callee).getPrty("prototype"))
					return NOT_NULL
				case 'CallExpression':
					var call = new CallNode({new: false, context: 'node_' + node.$id})
					visitExp(node.callee)
					unify(call.self, node.callee)
					if (node.callee.type === 'MemberExpression') {
						unify(call.this, node.callee.object)
					} else {
						assumeAny(call.this) // TODO: experiment with any vs unify with global object
					}
					for (var i=0; i<node.arguments.length; i++) {
						visitExp(node.arguments[i])
						unify(call.arguments.getPrty(String(i)), node.arguments[i])
					}
					unify(call.return, node)
					addCall(call)
					return NOT_NULL
				case 'MemberExpression':
					visitExp(node.object, NOT_VOID)
					if (node.computed) {
						visitExp(node.property, NOT_VOID)
						if (node.property.type === 'Literal') {
							unify(node, getNode(node.object).getPrty(String(node.property.value)))
						} else {
							addDynamicAccess(node.object, node.property, node)
						}
					} else {
						unify(node, getNode(node.object).getPrty(node.property.name))
					}
					return NOT_NULL
				case 'Identifier':
					if (node.name === 'undefined') {
						assumeType(node, {type: 'value', value: undefined})
						return NULL
					}
					unify(node, getVar(node))
					return NOT_NULL
				case 'Literal':
					if (node.value instanceof RegExp) {
						getNode(node).addType({type: 'reference', name:'RegExp', typeArguments:[]})
					} else {
						assumeType(node, {type: 'value', value: node.value})
					}
					return node.value === null ? NULL : NOT_NULL
				case 'ThisExpression':
					unify(node, fnode.this)
					return NOT_NULL
				default:
					throw new Error("Unknown expression: " + node.type)
			}
		}

		visitStmt(fun.body)

		return fnode
	}


	//////////////////////////////////
	// 		TYPES -> U-NODES		//
	//////////////////////////////////
	
	function sig2path(sig) {
		return '(' + sig.parameters.map(function(x) { return formatType(x.type) }).join(',') + ')'
	}

	// NATIVE CALL SIGS
	var special_natives = {
		'Function.prototype.apply': 1,
		'Function.prototype.call': 1
	}
	snapshot.heap.forEach(function(obj,i) {
		if (!obj)
			return
		if (obj.function && obj.function.type === 'native' & !special_natives.hasOwnProperty(obj.function.id)) {
			getCallSigsForNative(obj.function.id).forEach(function(sig) {
				getConcreteObject(i).call_sigs.add(sig)
			})
		}
	})

	//////////////////////////
	//		  SOLVER		//
	//////////////////////////

	var function2shared = Object.create(null)
	function getSharedFunctionNode(fun) {
		var fnode = function2shared[fun.$id]
		if (fnode)
			return fnode
		fnode = getPristineFunctionNode(fun)
		complete()
		beginClone()
		fnode = fnode.clone()
		endClone()
		fnode.calls.forEach(resolveCallLater)
		fnode.inherits.forEach(resolveInheritLater)
		fnode.dynamic_accesses.forEach(resolveDynamicAccessLater)
		includeFunctionInGraphviz(fnode)
		return function2shared[fun.$id] = fnode
	}

	var num_iterations = 0
	function solve() {
		var changed = true
		function unify(x,y) {
			x = x.rep()
			y = y.rep()
			if (x !== y) {
				unifyLater(x,y)
				changed = true
			}
		}
		while (changed) {
			changed = false

			num_iterations++
			// if (num_iterations % 1000 === 0) {
				// console.log(">> " + num_iterations + " iterations")
			// }

			// Resolve dynamic access
			complete()
			unresolved_dynamic_accesses.forEach(function(dnode) {
				if (dnode.object.isAny)
					return // nothing to do
				dnode.property.primitives.forEach(function(t) {
					switch (t.type) {
						case 'number':
							break; // TODO
						case 'string':
							// dnode.object.makeAny()
							// dnode.value.makeAny() // TODO: lvalue vs rvalue??
							break; // TODO collapse property names??
						case 'string-const':
						case 'value':
							unify(dnode.object.getPrty(String(t.value)), dnode.value)
							break;
					}
				})
			})

			// Resolve inheritance
			complete()
			unresolved_inherits.forEach(function(child) {
				child = child.rep()
				child.prototypes.forEach(function(proto) {
					proto = proto.rep()
					if (proto === child)
						return
					// compare properties that are present on both nodes
					// iterate over the smallest map to speed things up
					if (proto.properties.size > child.properties.size) {
						for (var k in child.properties) {
							if (k[0] !== '$')
								continue
							if (!(k in proto.properties))
								continue
							var protoPrty = proto.properties[k]
							var childPrty = child.properties[k]
							if (childPrty.type === 'node') {
								if (protoPrty.type === 'node') {
									unify(protoPrty.node, childPrty.node)
								}
								// TODO: inherit types from proto??
							}
						}
					} else {
						for (var k in proto.properties) {
							if (k[0] !== '$')
								continue
							if (!(k in child.properties))
								continue
							var protoPrty = proto.properties[k]
							var childPrty = child.properties[k]
							if (childPrty.type === 'node') {
								if (protoPrty.type === 'node') {
									unify(protoPrty.node, childPrty.node)
								}
								// TODO: inherit types from proto??
							}
						}
					}
				})
				complete()
			})
			
			// Resolve calls
			complete()
			unresolved_calls.forEach(function(call) {
				if (!call.resolved_sigs) {
					throw new Error(util.inspect(call))
				}
				var callee = call.self.rep()
				if (callee.isAny) {
					call.return.makeAny()
					return
				}
				callee.functions.forEach(function(fun) {
					switch (fun.type) {
						case 'user':
							if (!fun.id) {
								console.error(util.inspect(fun))
							}
							var fnode = getSharedFunctionNode(getFunction(fun.id))
							unify(fnode.self, call.self)
							unify(fnode.this, call.this)
							unify(fnode.arguments, call.arguments)
							unify(fnode.return, call.return)
							break;
						case 'native':
							switch (fun.id) {
								case 'Function.prototype.apply':
									if (!call.secondary) {
										resolveCallLater(call.secondary = new CallNode({new:call.new, context:call.context}))
										call.secondary.secondary = call.secondary // avoid potential infinite generation of CallNodes
									}
									unify(call.secondary.self, call.this)
									unify(call.secondary.this, call.arguments.getPrty(0))
									unify(call.secondary.arguments, call.arguments.getPrty(1))
									unify(call.secondary.return, call.return)
									break
								case 'Function.prototype.call':
									if (!call.secondary) {
										resolveCallLater(call.secondary = new CallNode({new:call.new, context:call.context}))
										call.secondary.secondary = call.secondary // avoid potential infinite generation of CallNodes
									}
									unify(call.secondary.self, call.this)
									call.arguments.properties.forEach(function(name,dst) {
										if (isNumberString(name) && name >= 0) {
											if (name === '0') {
												unify(call.secondary.this, call.arguments.getPrty(0))
											} else {
												unify(call.secondary.arguments.getPrty(Number(name)-1), call.arguments.getPrty(name))
											}
										}
									})
									unify(call.secondary.return, call.return)
									break
								case 'Function.prototype.bind':
									break
							}
							break;
						case 'bind':
							break; // TODO bound functions
						case 'unknown':
							break; // do nothing
					}
				})
				callee.call_sigs.forEach(function(sig) {
					if (call.resolved_sigs.has(sig))
						return
					// TODO: varargs

					var tcheck = makeTypeChecker(sig.typeParameters)
					var applicable = sig.parameters.all(function(param, i) {
						if (!call.arguments.properties.has(i))
							return param.optional
						return tcheck.isNodeCompatibleWithType(call.arguments.getPrty(i), param.type)
					})
					if (!applicable)
						return

					call.resolved_sigs.add(sig)

					var tenv = new Map
					sig.typeParameters.forEach(function(tp) {
						var tnode = new UNode
						tenv.put(tp.name, {type:'node', node: tnode})
						tcheck.getTypeVarBounds().get(tp.name).forEach(function(b) {
							if (b.type === 'node')
								unify(b.node, tnode)
							else
								tnode.addType(b.bound)
						})
					})
					call.return.addType(substType(sig.returnType, tenv))

					// TODO: handle callbacks

					// IDEA
					// Traverse parameter types in step with argument points-to graph.
					// When checking callback type (i.e. callsig in covariant position) against
					// a function, invoke it (deferred, only apply if entire check succeeds) using
					// the call signature. If a callback type is checked against a call signature,
					// mark the call signature as having been USED. If a function is every unified
					// with a call signature that is marked as being USED, we must treat the function
					// as being invoked using that call signature.
					// call.resolved_sigs.add(sig)
					// sig = instantiateCallSig(sig)

					// call.return.addType(sig.returnType)
					// unify(call.self, cnode.fnode.self)
					// unify(call.this, cnode.fnode.this)
					// unify(call.arguments, cnode.fnode.arguments)
					// unify(call.return, cnode.fnode.return)
				})
				complete()
			})
		}
	}

	//////////////////////////////////////
	//		  COMPATIBILITY TEST 		//
	//////////////////////////////////////
	function qualify(path,k) {
		if (!path)
			return null
		else if (k[0] === '[' || k[0] === '(')
			return path + k
		else
			return path + '.' + k
	}
	function reportError(path, msg) {
		if (!path)
			return
		console.log(path + ': ' + msg)
	}

	// Creates a new type checker instance.
	// A type checker instance becomes obsolete when the heap changes, and should not be reused after that point
	// - `freeTypeVars`: a list of type parameters (defaults to empty list if omitted)
	function makeTypeChecker(freeTypeVars) {
		if (!freeTypeVars)
			freeTypeVars = []

		var freeTypeEnv = new Map
		freeTypeVars.forEach(function(tp) {
			freeTypeEnv.put(tp.name, [])
		})
		// TODO: use type-param constraints for something

		function isPrtyCompatibleWithType(prty, type, path) {
			if (prty.type === 'node') {
				return isNodeCompatibleWithType(prty.node, type, path)
			} else {
				var ok = prty.types.some(function(t) {
					return isTypeCompatibleWithType(t, type, null)
				})
				if (!ok) {
					reportError(path, 'expected ' + formatType(type) + ' but found ' + formatUnion(prty.types))
				}
				return ok
			}
		}
		var node_prty_compatible = Object.create(null)
		function isNodeCompatibleWithProperty(node, k, prty, path) {
			node = node.rep()
			var dst = node.properties.get(k)
			if (dst) {
				return isPrtyCompatibleWithType(dst, prty.type, path)
			} else {
				var protoWithPrty = node.prototypes.filter(function(proto) {
					return proto.properties.has(k)
				})
				protoWithPrty = protoWithPrty.unique(function(proto) { return proto.rep().id })
				if (protoWithPrty.length === 0) {
					if (!prty.optional) {
						reportError(path, 'expected ' + formatType(prty.type) + ' but found nothing')
						return false
					}
					return true
				} else if (protoWithPrty.length === 1) {
					return isPrtyCompatibleWithType(protoWithPrty[0].properties.get(k), prty.type, path)
				} else {
					var h = node.id + '~' + k + '~' + prty.optional + '.' + canonicalizeType(prty.type)
					if (h in node_prty_compatible)
						return node_prty_compatible[h]
					node_prty_compatible[h] = false	
					var ok = node.prototypes.some(function(proto) {
						return isNodeCompatibleWithProperty(proto, k, prty, null) // TODO: avoid duplicate error messages
					})
					if (!ok) {
						reportError(path, 'expected ' + prty.type + ' but found [complex type]')
					}
					node_prty_compatible[h] = ok
					return ok
				}
			}
		}
		var node_type_compatible = Object.create(null)
		function isNodeCompatibleWithType(node, type, path) {
			node = node.rep()
			if (node.isAny)
				return true
			if (!node.isObject && type.type === 'reference') {
				reportError(path, 'expected ' + formatType(type) + ' but found ' + formatNodeAsPrimitive(node) + " [non-object]")
				return
			}
			var h = canonicalizeType(type) + "~" + node.id
			if (h in node_type_compatible) {
				return node_type_compatible[h]
			}
			node_type_compatible[h] = true
			return node_type_compatible[h] = isNodeCompatibleWithTypeX(node, type, path)
		}
		function isNodeCompatibleWithTypeX(node, type, path) {
			node = node.rep()
			if (node.isAny || node.primitives.has({type:'value', value:null}))
				return true
			var ok = true
			if (type.type === 'reference')
				type = resolveTypeRef(type)
			switch (type.type) {
				case 'object':
					if (!node.isObject) {
						reportError(path, 'expected ' + formatType(type) + ' but found ' + formatNodeAsPrimitive(node) + " [non-object]")
						return false
					}
					for (var k in type.properties) {
						if (!isNodeCompatibleWithProperty(node, k, type.properties[k], qualify(path,k))) {
							return false
						}
					}
					if (type.numberIndexer) {
						var ok = node.properties.all(function(name,dst) {
							if (!isNumberString(name))
								return true
							return isPrtyCompatibleWithType(dst, type.numberIndexer, path && (path + '[' + name + ']'))
						})
						if (!ok)
							return false
					}
					if (type.stringIndexer) {
						var ok = node.properties.all(function(name,dst) {
							// FIXME: enumerability check?
							return isPrtyCompatibleWithType(dst, type.stringIndexer, path && (path + "['" + name + "']"))
						})
						if (!ok)
							return false
					}
					return ok
				case 'node':
					ok = (node === type.node.rep())
					if (!ok) {
						reportError(path, "expected generic type " + type.name + " but found " + formatNode(node))
					}
					return ok
				case 'enum':
					var enum_vals = enum_values.get(type.name)
					if (enum_vals.length === 0) {
						return true
					}
					var ok = enum_vals.some(function(v) {
						return isNodeCompatibleWithValue(node, v)
					})
					if (!ok) {
						reportError(path, 'expected ' + type.name + ' but found ' + formatNodeAsPrimitive(node))
					}
					return ok
				case 'any':
				case 'void':
					return true
				case 'number':
				case 'string':
				case 'boolean':
					if (node.primitives.has({type: type.type}))
						return true
					var ok = node.primitives.some(function(t) {
						return t.type === 'value' && typeof t.value === type.type
					})
					if (!ok) {
						reportError(path, 'expected ' + formatType(type) + ' but found ' + formatNodeAsPrimitive(node))
					}
					return ok
				case 'string-const':
					if (node.primitives.has({type: 'value', value: type.value}))
						return true
					if (node.primitives.has({type: 'string'}))
						return true
					reportError(path, 'expected ' + formatType(type) + ' but found ' + formatNodeAsPrimitive(node))
					return false
				case 'type-param':
					if (!freeTypeEnv.has(type.name))
						throw new Error("Unbound type variable: " + type.name)
					freeTypeEnv.push(type.name, {type: 'node', node: node})
					return true
				default:
					throw new Error("Unexpected type: " + util.inspect(type))
			}
			return true
		}
		function isNodeCompatibleWithValue(node, v) {
			node = node.rep()
			if (v === null)
				return true
			if (v && typeof v === 'object')
				return node === getConcreteObject(v.key)
			if (node.primitives.has({type:'value', value:v}))
				return true
			switch (typeof v) {
				case 'number':
					return node.primitives.has({type:'number'})
				case 'string':
					return node.primitives.has({type:'string'})
				case 'boolean':
					return node.primitives.has({type:'boolean'})
				case 'undefined':
					return node.primitives.has({type:'void'})
				default:
					throw new Error("Unexpected value: " + util.inspect(v))
			}
		}
		var type2type_compatible = Object.create(null)
		function isTypeCompatibleWithType(t1, t2, path) {
			if (t1.type === 'reference' || t2.type === 'reference') {
				var h = canonicalizeType(t1) + '~' + canonicalizeType(t2)
				if (h in type2type_compatible)
					return type2type_compatible[h]
				type2type_compatible[h] = true
				return type2type_compatible[h] = isTypeCompatibleWithTypeX(t1, t2, path)
			}
			return isTypeCompatibleWithTypeX(t1, t2, path)
		}
		function isTypeCompatibleWithTypeX(t1, t2, path) {
			if (t1.type === 'any' || t2.type === 'any')
				return true
			if (t1.type === 'reference' && t2.type === 'reference' && t1.name === t2.name) {
				// Approximate compatibility check on references by simply checking type arguments
				// This not technically not a compatibility check between structural types, but
				// I will expect it will produce more useful error messages, 
				// e.g. "expected string[] but found number[]" 
				var ok = t1.typeArguments.all(function(p1, i) {
					return isTypeCompatibleWithType(p1, t2.typeArguments[i], null)
				})
				if (!ok) {
					reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
				}
				return ok
			}
			if (t1.type === 'reference' && t2.type === 'reference') {
				// expand both references, but cut off the path here, so we don't report
				// a complicated message describing why the two references are incompatible
				// e.g. "expected Promise but found HttpRequest" instead of unfolding both types in the error message
				var ok = isTypeCompatibleWithType(resolveTypeRef(t1), resolveTypeRef(t2), null)
				if (!ok) {
					reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
				}
				return ok
			}
			if (t2.type === 'reference')
				t2 = resolveTypeRef(t2)
			if (t2.type === 'object' && (t1.type !== 'object' && t1.type !== 'reference')) {
				// Coerce t1 to an object. If the compatibility check fails, report the error
				// as simply "expected XX but found number" instead of a complicated message resulting from
				// a structural compatibility check
				var t1o = coerceTypeToObject(t1)
				if (t1o.type === 'object' || t1o.type === 'reference') {
					var ok = isTypeCompatibleWithType(t1o, t2, null)
					if (!ok) {
						reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
					}
					return ok
				}
			}
			switch (t2.type) {
				case 'object':
					if (t1.type === 'reference')
						t1 = resolveTypeRef(t1)
					if (t1.type !== 'object') {
						reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
						return false
					}
					for (var k in t2.properties) {
						if (k in t1.properties) {
							if (!isTypeCompatibleWithType(t1.properties[k].type, t2.properties[k].type, qualify(path,k))) {
								return false
							}
						}
						else if (t1.numberIndexer && isNumberString(k)) {
							if (!isTypeCompatibleWithType(t1.numberIndexer, t2.properties[k].type, qualify(path, k))) {
								return false
							}
						}
						else if (t1.stringIndexer) {
							if (!isTypeCompatibleWithType(t1.stringIndexer, t2.properties[k].type, qualify(path, k))) {
								return false
							}	
						}
						else {
							if (!t2.properties[k].optional) {
								reportError(qualify(path,k), 'expected ' + formatType(t2) + ' but found nothing')
								return false
							}
						}
					}
					if (t2.numberIndexer) {
						for (var k in t1.properties) {
							if (isNumberString(k)) {
								if (!isTypeCompatibleWithType(t1.properties[k].type, t2.numberIndexer, qualify(path, k))) {
									return false
								}
							}
						}
						if (t1.numberIndexer) {
							if (!isTypeCompatibleWithType(t1.numberIndexer, t2.numberIndexer, qualify(path, '[number]'))) {
								return false
							}
						}
					}
					if (t2.stringIndexer) {
						for (var k in t1.properties) {
							// TODO: enumerability check?
							if (!isTypeCompatibleWithType(t1.properties[k].type, t2.stringIndexer, qualify(path, k))) {
								return false
							}
						}
						if (t1.stringIndexer) {
							if (!isTypeCompatibleWithType(t1.stringIndexer, t2.stringIndexer, qualify(path, '[number]'))) {
								return false
							}
						}
					}
					// TODO: calls, brands?
					return true
				case 'number':
				case 'string':
				case 'boolean':
					var ok = t1.type === t2.type || (t1.type === 'value' && typeof t1.value === t2.type)
					if (!ok) {
						reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
					}
					return ok
				case 'string-const':
					var ok = t1.type === 'string' || (t1.type === 'value' && t1.value === t2.value)
					if (!ok) {
						reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
					}
					return ok
				case 'value':
					var ok = (t1.type === typeof t2.value) || (t1.type === 'value' && t1.value === t2.value)
					if (!ok) {
						reportError(path, 'expected ' + formatType(t2) + ' but found ' + formatType(t1))
					}
					return ok
				case 'enum':
					return true // TODO: check enum type properly
				case 'void':
					return true
				case 'node':
					reportError(path, 'expected generic type ' + t2.name + ' but found ' + formatType(t1))
					return false
				case 'type-param':
					if (!freeTypeEnv.has(t2.name))
						throw new Error("Unbound type variable: " + t2.name)
					freeTypeEnv.push(t2.name, {type: 'type', bound: t1})
					return true
				default:
					throw new Error("Unexpected type: " + t2.type)
			}
		}
		return {
			isTypeCompatibleWithType: isTypeCompatibleWithType,
			isNodeCompatibleWithType: isNodeCompatibleWithType,
			isPrtyCompatibleWithType: isPrtyCompatibleWithType,
			isNodeCompatibleWithProperty: isNodeCompatibleWithProperty,
			getTypeVarBounds: function() { return freeTypeEnv }
		}
	}
	
	function formatNodeAsPrimitive(node) {
		if (node.isAny)
			return 'any'
		var b = []
		node.primitives.forEach(function(t) {
			b.push(formatType(t))
		})
		if (b.length === 0) {
			if (node.isObject)
				return 'object'
			else
				return 'nothing'
		}
		else {
			return b.join('|')
		}
	}
	function formatNode(node) {
		if (node.isAny)
			return 'any'
		var b = []
		if (node.isObject)
			b.push('object')
		node.primitives.forEach(function(t) {
			b.push(formatType(t))
		})
		if (b.length === 0) {
			return 'nothing'
		} else {
			return b.join('|')
		}
	}
	function formatUnion(ut) {
		if (ut.has({type:'any'}))
			return 'any'
		var b = []
		ut.forEach(function(t) {
			b.push(formatType(t))
		})
		if (b.length === 0) {
			return 'nothing'
		} else {
			return b.join('|')
		}
	}

	//////////////////////////////////////
	//			CHECK SIGNATURE 		//
	//////////////////////////////////////

	function singleton(t) {
		var set = new TypeSet
		set.add(t)
		return set
	}

	this.checkSignature = function(sig, function_key, receiver_key, path) {
		var call = new CallNode({new:sig.new, context: '0'})

		var tenv = new Map
		sig.typeParameters.forEach(function(tp) {
			var tnode = new UNode
			tenv.put(tp.name, {type: 'node', node: tnode, name:tp.name})
			if (tp.constraint) {
				tnode.addType(substType(tp.constraint, tenv))
			}
		})
		// TODO: varargs

		call.self = getConcreteObject(function_key)
		if (sig.new) {
			call.this.isObject = true
			call.this.prototypes.push(getConcreteObject(function_key).getPrty('prototype'))
			resolveInheritLater(call.this)
			// call.this = getConcreteObject(function_key).getPrty('prototype') // TODO: proper inheritance instead of this
		} else {
			call.this = getConcreteObject(receiver_key)
		}
		sig.parameters.forEach(function(param,i) {
			call.arguments.properties.put(i, {
				type: 'union',
				types: singleton(substType(param.type,tenv))
			})
		})

		resolveCallLater(call)
		solve()

		var resultNode = sig.new ? call.this : call.return
		var resultType = substType(sig.returnType, tenv)

		var tcheck = makeTypeChecker()

		return tcheck.isNodeCompatibleWithType(resultNode, resultType, path + sig2path(sig))

		// graphviz.visitCall(call)
		// graphviz.visitNode(getConcreteObject(lookupPath("Foo").key))
		// graphviz_functions.forEach(function(fnode) {
		// 	graphviz.visitFNode(fnode)
		// })
		// graphviz_nodes.forEach(function(fnode) {
		// 	graphviz.visitNode(fnode)
		// })
		// var filename = (graphvizCounter++) + '.dot'
		// console.log("writing to " + filename)
		// fs.writeFileSync(filename, graphviz.finish())
	}
	
	//////////////////////////////////////
	//			GRAPHVIZ DOT     		//
	//////////////////////////////////////
	function Graphviz() {
		var sb = []
		function print(x) {
			sb.push(x)
		}
		print("digraph {")

		var seen_nodes = Object.create(null)
		function makeNodeLabel(node) {
			var str = []
			if (node.isObject) {
				str.push("object")
			}
			if (node.isAny) {
				str.push("any")
			}
			if (node.global) {
				str.push("global")
			}
			node.primitives.forEach(function(t) {
				str.push(formatType(t))
			})
			return str.join(',')
		}
		var tnode_id = 1;
		function makeTypeNodeId() {
			return 'T' + (tnode_id++)
		}
		function visitTypeNode(tnode, id) {
			print(id + ' [shape=diamond]')
		}
		function visitNode(node) {
			node = node.rep()
			if (seen_nodes[node.id])
				return
			seen_nodes[node.id] = true
			print(node.id + ' [shape=box,label="' + escapeLabel(makeNodeLabel(node)) + '"]')
			if (!node.global || isLive(node)) {
				markAsLive(node)
				node.properties.forEach(function(name,dst) {
					if (name in {})
						return // ignore trivial properties
					if (dst.type === 'node') {
						print(node.id + ' -> ' + dst.node.rep().id + ' [label="' + escapeLabel(name) + '"]')
						visitNode(dst.node)
					} else {
						var id = makeTypeNodeId()
						print(node.id + ' -> ' + id + ' [label="' + escapeLabel(name) + '"]')
						visitTypeNode(dst, id)
					}
				})
				node.prototypes.forEach(function(proto) {
					print(node.id + ' -> ' + proto.rep().id + ' [label="[proto]"]')
					visitNode(proto)
				})
			}
		}

		function visitFNode(fnode) {
			visitNode(fnode.self)
			visitNode(fnode.this)
			visitNode(fnode.arguments)
			visitNode(fnode.return)
			if (fnode.env)
				visitNode(fnode.env)
			// todo: calls?
		}
		var calln = 0
		function visitCall(call) {
			visitNode(call.self)
			visitNode(call.this)
			visitNode(call.arguments)
			visitNode(call.return)
			var id = 'call_' + (calln++)
			print(id + ' [shape=record,label="{{<self> self|<this> this|<arguments> arguments|<return> return}}"]')
			print(call.self.rep().id + " -> " + id + ':self')
			print(call.this.rep().id + " -> " + id + ':this')
			print(call.arguments.rep().id + " -> " + id + ':arguments')
			print(call.return.rep().id + " -> " + id + ':return')
		}

		var node2live = Object.create(null)
		function isLive(node) {
			return node2live[node.rep().id]
		}
		function markAsLive(node) {
			node2live[node.rep().id] = true
		}
		function checkLive(node) {
			node = node.rep()
			if (node.id in node2live)
				return node2live[node.id]
			node2live[node.id] = false
			var isLive = false
			node.properties.forEach(function(name,dst) {
				if (dst.type === 'node' && checkLive(dst.node)) {
					isLive = true
				}
			})
			return node2live[node.id] = isLive
		}
		
		function findAdditionalNodes() {
			all_unodes.forEach(function(node) {
				if (checkLive(node)) {
					visitNode(node)
				}
			})
		}

		this.visitNode = visitNode
		this.visitFNode = visitFNode
		this.visitCall = visitCall
		this.finish = function() {
			findAdditionalNodes()
			print("}\n")
			return sb.join('\n')
		}
	}
}


function isCallSubtypeOf(incall, outcall) {
	// TODO: type parameters
	// TODO: variadic

	// Check that the parameters to outcall can be used in a valid call to incall
	for (var i=0; i<incall.parameters.length; ++i) {
		var iparm = incall.parameters[i]
		if (i < outcall.parameters.length) {
			var oparm = outcall.parameters[i]
			if (!isTypeCompatible(oparm.type, iparm.type, {type: 'any'})) {
				return false
			}
		} else if (!iparm.optional) {
			return false
		}
	}

	// Check that return type from incall is a valid return type from outcall
	return isTypeCompatible(incall.returnType, outcall.returnType, {type: 'any'})
}



function substituteParameterType(t) {
	if (t.type === 'string-const') {
		return {type: 'value', value: t.value}
	} else {
		return t
	}
}

function getFunctionPrettyName(f) {
	return f.$function_id;
}


// ------------------------------------------------
// 		Points-to graph to Graphviz Dot
// ------------------------------------------------

function escapeLabel(lbl) {
	return lbl.replace(/[{}"<>]/g, '\\$&').replace(/\t/g,'\\t').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\f/g,'\\f')
}

function pointsToDot(nodes) {
	var sb = []
	function println(x) {
		sb.push(x)
	}
	function formatUnionType(type) {
		if (type.any)
			return "any"
		else {
			var sb = []
			for (var k in type.table) {
				sb.push(formatType(type.table[k]))
			}
			return sb.join("|")
		}
	}
	println("digraph {")
	nodes.forEach(function(node) {
		println("  " + node.id + ' [shape=box,label="' + escapeLabel(formatUnionType(node.type)) +  '"]')
		node.properties.forEach(function(name, dst) {
			dst = dst.rep()
			println("  " + node.id + " -> " + dst.id + " [label=\"" + escapeLabel(name) + "\"]")
		})
	})
	println("}")
	return sb.join('\n')
}

// ------------------------
// 		Entry Point
// ------------------------

function main() {
	// TODO: move loading of inputs into main function
	check(lookupQType(typeDecl.global,[]), {key: snapshot.global}, '', false, null, '<global>');
	if (program.suggest) {
		findSuggestions()
	}
	if (program.coverage) {
		printCoverage();
	}
}

onLoaded(main)
