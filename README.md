tscheck
=======

Analysis tool for TypeScript interfaces.


Normalized Type Format
======================

tscheck converts a TypeScript declaration file (`*.d.ts`) into a type environment in the following format:

```
type TypeScriptDeclarationFile = {
	env: TypeEnv
	global: string 	// name of global type in TypeEnv
}

interace StringMap[T] = {
	[s:string]: T
}

type TypeEnv = StringMap[TypeDef]
type Type = TypeDef | TypeRef
type TypeDef 
	= ObjectType 
	| EnumType 
	| BuiltinType 
	| StringConstType 
	| TypeParamRef 
	| GenericType

interface TypeRef {
	type: 'reference',
	name: string 	// index into TypeEnv
}
interface ObjectType {
	type: 'object'
	typeParameters: Array[TypeParameter]
	properties: StringMap[Property]
	calls: Array[Call]
	stringIndexer: Type | null
	numberIndexer: Type | null
	supers: Array[Type]
}
interface Property {
	optional: boolean
	type: Type
}
interface Call {
	new: boolean
	variadic: boolean
	typeParameters: Array[TypeParameter]
	parameters: Array[Parameter]
	returnType: Type
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
interface GenericType {
	type: 'generic'
	base: Type
	args: Array[Type]
}
```
