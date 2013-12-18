tscheck
=======

Analysis tool for TypeScript interfaces.


Normalized Type Format
======================

tscheck converts a TypeScript declaration file (`*.d.ts`) into a type environment in the following format:

```
type TypeScriptDeclarationFile = {
	global: string 	// name of global type in env
	env: StringMap[TypeDef]
	externs: StringMap[string] // external module names -> key in TypeEnv,
	enums: StringMap[EnumDef]
}

interace StringMap[T] = { // map from string to T
	[s:string]: T 	
}

// paths to values of enum, (eg. [Foo.X, Foo.Y, Foo.Z])
type EnumDef = Array[String] 

interface TypeDef {
	typeParameters: Array[string],
	object: ObjectType
}

type Type
	= ObjectType 
	| EnumType 
	| BuiltinType 
	| StringConstType 
	| TypeParamRef 
	| TypeRef

interface TypeRef {
	type: 'reference',
	name: string 	// index into type env
	typeArguments: Array[Type]
}
interface ObjectType {
	type: 'object'
	properties: StringMap[Property]
	calls: Array[Call]
	stringIndexer: Type | null
	numberIndexer: Type | null
	meta: {
		kind: 'module' | 'class' | 'interface'
	}
}
interface Property {
	optional: boolean
	type: Type
	meta: {
		origin: string  	     // which file contributed the property
	}
}
interface Call {
	new: boolean
	variadic: boolean
	typeParameters: Array[TypeParameter]
	parameters: Array[Parameter]
	returnType: Type
	meta: {
		implicit: boolean 	// true if default constructor
	}
}
}
interface Parameter {
	optional: boolean
	name: string
	type: Type
}
interface TypeParameter {
	name: string
	constraint: Type | null
}
interface EnumType {
	type: 'enum'
	name: string
}
interface BuiltinType {
	type: 'number' | 'string' | 'boolean' | 'void' | 'any'
}
interface StringConstType {
	type: 'string-const'
	value: string
}
interface TypeParamRef {
	type: 'type-param'
	name: string
}
```
