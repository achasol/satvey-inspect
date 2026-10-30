"""Regenerate the checked-in API contract; no external dependencies."""
import json
from pathlib import Path

S = {"type": "string"}
UUID = {"type": "string", "format": "uuid"}
INT = {"type": "integer"}
def ref(name): return {"$ref": "#/components/schemas/" + name}
def array(value): return {"type": "array", "items": value}
def enum(*values): return {"type": "string", "enum": list(values)}
def obj(properties, required=None): return {"type": "object", "properties": properties, "required": list(properties) if required is None else required, "additionalProperties": False}

schemas = {
 "Error": obj({"error": S}), "ID": obj({"id": UUID}), "OK": obj({"ok": {"type": "boolean"}}),
 "Version": obj({"version": INT}),
 "Property": obj({"id": UUID, "address": S, "postcode": S, "city": S}),
 "Organisation": obj({"id": UUID, "slug": S, "name": S, "role": S, "roleId": UUID, "roleName": S, "privileges": array(S)}),
 "Account": obj({"user": obj({"id": UUID, "name": S, "email": S}), "organisations": array(ref("Organisation"))}),
 "Inspection": obj({"id": UUID, "propertyId": UUID, "address": S, "postcode": S, "city": S, "kind": enum("pre", "final"), "status": enum("draft", "final"), "scheduledAt": {"type": ["string", "null"], "format": "date-time"}, "createdAt": {"type": "string", "format": "date-time"}}),
 "Room": obj({"id": UUID, "name": S}),
 "Batch": obj({"id": UUID, "roomId": UUID, "status": enum("pending", "reviewed", "excluded"), "version": INT, "createdAt": S}),
 "Media": obj({"id": UUID, "batchId": UUID, "kind": enum("photo", "audio"), "name": S, "mime": S, "size": INT, "duration": {"type": "number"}}, ["id", "batchId", "kind", "name", "mime"]),
 "Observation": obj({"id": UUID, "batchId": UUID, "title": S, "description": S, "label": S, "status": enum("draft", "approved", "rejected"), "source": enum("manual", "mock", "ai"), "version": INT, "photoIds": array(UUID)}),
 "Job": obj({"batchId": UUID, "status": enum("pending", "processing", "done", "failed"), "provider": enum("mock", "baseten"), "error": S}),
 "Member": obj({"id": UUID, "email": S, "name": S, "role": S, "roleId": UUID, "roleName": S}),
 "SSO": obj({"issuer": S, "clientId": S, "domains": array(S)}),
}
schemas["SignatureInput"]=obj({"name":{**S,"maxLength":120},"role":enum("inspector","resident","other"),"strokes":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"array","minItems":2,"items":obj({"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1}})}}})
schemas["ReportSignature"]=obj({**schemas["SignatureInput"]["properties"],"signedAt":{"type":"string","format":"date-time"},"collectedBy":UUID})
schemas["Dossier"] = obj({"inspection": ref("Inspection"), "rooms": array(ref("Room")), "batches": array(ref("Batch")), "media": array(ref("Media")), "observations": array(ref("Observation")), "jobs": array(ref("Job"))})
schemas["ReportObservation"] = obj({k: schemas["Observation"]["properties"][k] for k in ["id", "batchId", "title", "description", "label", "photoIds"]})
schemas["Report"] = obj({**{k: v for k, v in schemas["Dossier"]["properties"].items() if k != "jobs"}, "observations": array(ref("ReportObservation")), "id": UUID, "createdAt": S})
schemas["Report"]["properties"]["signatures"]={"type":"array","maxItems":10,"items":ref("ReportSignature")}

spec = {"openapi": "3.1.0", "info": {"title": "Satvey Inspect API", "version": "1.0.0", "description": "Session-cookie authentication. Every mutating request requires X-Satvey-Request: 1; browser Origin must match APP_URL or an explicitly trusted origin. Organisation routes enforce membership and role permissions. Versioned edits return 409 on conflicts. Image analysis creates draft observations, never approvals."}, "servers": [{"url": "/api/v1"}], "security": [{"session": []}], "paths": {}, "components": {"schemas": schemas, "securitySchemes": {"session": {"type": "apiKey", "in": "cookie", "name": "satvey_session"}}}}

def operation(path, method, summary, response=None, body=None, status=200, public=False, description=""):
 parameters=[]
 for name in ["org", "inspection", "batch", "media", "observation", "user", "token", "norm", "asset", "assessment", "role", "element", "property", "source", "import"]:
  if "{"+name+"}" in path: parameters.append({"name": name, "in": "path", "required": True, "schema": S if name == "token" else UUID})
 if method not in ["get", "head"]: parameters.append({"name": "X-Satvey-Request", "in": "header", "required": True, "schema": {"type": "string", "const": "1"}})
 responses={str(status): {"description": "Success", **({"content": {"application/json": {"schema": response}}} if response else {})}}
 for code in [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503]: responses[str(code)]={"description": {400:"Invalid input",401:"Authentication required",403:"Forbidden",404:"Not found",409:"Conflict or finalised inspection",413:"File too large",415:"Unsupported media type",422:"Review incomplete",429:"Rate limited",500:"Server error",503:"Storage or processing unavailable"}[code], "content": {"application/json": {"schema": ref("Error")}}}
 value={"summary": summary, "operationId": method+"_"+path.replace("/","_").replace("{","").replace("}",""), "parameters": parameters, "responses": responses}
 if public: value["security"]=[]
 if description: value["description"]=description
 if body: value["requestBody"]={"required": True, "content": {"application/json": {"schema": body}}}
 spec["paths"].setdefault(path,{})[method]=value
 return value

operation("/health","get","Database, object storage and PDF readiness",obj({"status":S}),public=True)
operation("/health/live","get","Process liveness",obj({"status":S}),public=True)
operation("/health/ready","get","Database, object storage and PDF readiness",obj({"status":S}),public=True)
operation("/auth/discover","post","Choose login method from exact configured email domain",obj({"method":enum("password","sso"),"url":S},["method"]),obj({"email":S}),public=True)
operation("/auth/login","post","Email/password login",ref("OK"),obj({"email":S,"password":S}),public=True)
operation("/auth/logout","post","Revoke the current session",ref("OK"),obj({}),public=True)
operation("/auth/password","post","Set/change own password and revoke existing sessions",body=obj({"current":S,"password":{"type":"string","minLength":12,"maxLength":256}}))
operation("/auth/password/forgot","post","Request password recovery without disclosing account existence",ref("OK"),obj({"email":S}),202,public=True,description="Rate limited. Sends a one-hour single-use link for existing password accounts; SSO-only accounts recover with their provider.")
operation("/auth/password/reset","post","Consume recovery token, change password and revoke all sessions",ref("OK"),obj({"token":{"type":"string","minLength":64,"maxLength":64},"password":{"type":"string","minLength":12,"maxLength":256}}),public=True)
operation("/me","get","Current account and organisation memberships",ref("Account"))
start=operation("/auth/oidc/start","get","Start browser OIDC flow",status=302,public=True)
start["parameters"] += [{"name":"org","in":"query","required":True,"schema":S},{"name":"email","in":"query","schema":S},{"name":"link","in":"query","schema":enum("true")}]
callback=operation("/auth/oidc/callback","get","Verify provider response and establish session or pending identity link",status=302,public=True)
callback["parameters"] += [{"name":n,"in":"query","required":True,"schema":S} for n in ["code","state"]]
operation("/auth/oidc/link","get","Read pending, browser-bound identity link",obj({"email":S}),public=True)
operation("/auth/oidc/link","post","Prove existing password account before linking verified SSO identity",ref("OK"),obj({"password":S}),public=True)
operation("/invitations/{token}","get","Read unexpired invitation",obj({"email":S,"organisation":S,"role":S}),public=True)
operation("/invitations/accept","post","Accept invitation as signed-in user or create password account",ref("OK"),obj({"token":S,"name":S,"password":S},["token"]),public=True)
root="/orgs/{org}"
operation(root+"/members","get","List members (settings.manage)",array(ref("Member")))
operation(root+"/members/{user}","put","Assign organisation role or remove member; retain a member with settings.manage",ref("OK"),obj({"roleId":UUID,"role":enum("admin","inspector","viewer","quality_manager","remove")},[]))
operation(root+"/invitations","post","Create invitation link (settings.manage)",obj({"id":UUID,"url":S,"delivery":enum("manual","pending")}),obj({"email":S,"roleId":UUID,"role":S},["email"]),201)
operation(root+"/invitations","get","List pending invitations and email delivery status (settings.manage)",array(obj({"id":UUID,"email":S,"roleId":UUID,"expiresAt":S,"delivery":enum("manual","pending","processing","done","failed","cancelled")})))
operation(root+"/invitations/{invitation}/resend","post","Rotate invitation token and requeue delivery (settings.manage)",obj({"id":UUID,"url":S,"delivery":enum("manual","pending")}),obj({}),description="Revokes the previous link. Invitation expires seven days after resend.")
operation(root+"/sso","get","Read SSO settings without secrets (settings.manage)",ref("SSO"))
operation(root+"/sso","put","Configure SSO and canonical domains (settings.manage)",ref("OK"),obj({"issuer":S,"clientId":S,"clientSecret":S,"domains":array(S)},["issuer","clientId","domains"]),description="Blank clientSecret preserves an existing secret. Exact domains are globally unique across organisations. Empty issuer disables SSO.")
catalog=operation(root+"/properties","get","Search the tenant property catalog",ref("PropertyPage"))
catalog["parameters"] += [{"name":"q","in":"query","schema":{**S,"maxLength":240}}, {"name":"page","in":"query","schema":{"type":"integer","minimum":1,"maximum":1000000,"default":1}}, {"name":"state","in":"query","schema":enum("linked","provisional")}]
operation(root+"/properties","post","Create a provisional property idempotently",ref("Property"),obj({"id":UUID,"address":S,"postcode":S,"city":S},["id","address"]),201,description="Provisional properties may be inspected, but reports cannot be finalised until an administrator confirms their source identity.")
operation(root+"/properties/{property}","get","Read current catalog facts",ref("Property"))
operation(root+"/properties/{property}/refresh","post","Queue a refresh of one VERA property",obj({"jobId":UUID}),obj({}),202)
operation(root+"/properties/{property}/link","post","Confirm a provisional property's source identity",obj({"propertyId":UUID,"inspections":INT}),obj({"targetPropertyId":UUID,"revision":INT,"targetRevision":INT}),description="Requires settings.manage. Compares both revisions, redirects draft inspections to the linked target, adopts its snapshot, records an audit event and invalidates dependent reviews. Final reports remain frozen.")
operation(root+"/property-sources","get","Read source configuration and recent sync jobs",ref("PropertySourceData"),description="Requires settings.manage. Credentials are never returned.")
operation(root+"/property-sources","post","Create a source administration",ref("ID"),ref("PropertySourceInput"))
operation(root+"/property-sources/{source}","put","Update source configuration with optimistic revision",ref("ID"),ref("PropertySourceInput"))
operation(root+"/property-sources/{source}/test","post","Test VERA authentication, units and resource references without importing",obj({"ok":{"type":"boolean"},"sampleCount":INT}),obj({}))
operation(root+"/property-sources/{source}/sync","post","Queue a resumable VERA catalog sync",obj({"jobId":UUID}),obj({}),202)
template=operation(root+"/property-import-template","get","Download the UTF-8 CSV template")
template["responses"]["200"]={"description":"CSV header row","content":{"text/csv":{"schema":S}}}
operation(root+"/property-sources/{source}/imports","post","Validate and preview a CSV import",ref("PropertyImport"),obj({"csv":S}),description="Requires settings.manage and an enabled CSV source. Returns row errors without an import ID when invalid. Valid previews expire after one hour and show up to 100 changed rows. Maximum 10,000 rows; JSON request limit is 1 MiB. Missing properties are never deleted.")
operation(root+"/property-sources/{source}/imports/{import}/confirm","post","Confirm a validated CSV import atomically and idempotently",ref("OK"),obj({}),description="Rejects expired previews or source/catalog changes since validation with 409.")
inspection_list=operation(root+"/inspections","get","List inspections with bounded paging and address/city search",array(ref("Inspection")))
inspection_list["parameters"] += [{"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100,"default":50}},{"name":"offset","in":"query","schema":{"type":"integer","minimum":0,"maximum":1000000,"default":0}},{"name":"q","in":"query","schema":{"type":"string","maxLength":200}}]
operation(root+"/inspections","post","Create inspection with pinned property facts and published format idempotently",ref("ID"),obj({"id":UUID,"propertyId":UUID,"formatVersionId":UUID,"normVersionId":{"type":["string","null"],"format":"uuid"},"kind":enum("pre","final"),"scheduledAt":{"type":["string","null"],"format":"date-time"}},["id","propertyId","kind","formatVersionId"]),201)
inspection=root+"/inspections/{inspection}"
operation(inspection+"/property-context","post","Explicitly adopt compared catalog facts and invalidate dependent reviews",obj({"contextVersion":INT}),obj({"contextVersion":INT,"propertyRevision":INT}),description="Requires inspections.write and a draft inspection. Preserves human corrections, revokes worker leases and queues reanalysis.")
operation(inspection,"get","Read consistent inspection dossier",ref("Dossier"))
operation(inspection,"delete","Permanently delete an inspection and its dossier",status=204,description="Requires inspections.write. Deletes draft or final inspections, report, reviews and media records. Stored files are queued for retryable cleanup; the property and shared policy remain available.")
operation(inspection+"/rooms","post","Add room idempotently",ref("Room"),obj({"id":UUID,"name":S}),201)
operation(inspection+"/batches","post","Declare room capture and expected media IDs idempotently",ref("ID"),obj({"id":UUID,"roomId":UUID,"mediaIds":{"type":"array","items":UUID,"minItems":1,"maxItems":30,"uniqueItems":True},"analysisProvider":enum("mock")},["id","roomId","mediaIds"]),201,description="analysisProvider=mock is only accepted when ALLOW_MOCK_ANALYSIS=true. Normally omit it to use the configured provider.")
operation(inspection+"/batches/{batch}","put","Review, exclude or reopen a capture batch",ref("Version"),obj({"status":enum("pending","reviewed","excluded"),"version":INT}))
operation(inspection+"/batches/{batch}/analysis","post","Retry failed image analysis or skip to manual review",ref("OK"),obj({"action":enum("retry","skip")}))
upload=operation(inspection+"/batches/{batch}/media/{media}","put","Upload declared media bytes idempotently",ref("ID"),status=201,description="Raw body, up to 20 MiB/photo or 50 MiB/audio. Content is validated. Repeating identical bytes returns 200; different bytes under an existing ID return 409. Finalised inspections reject writes.")
upload["responses"]["200"]={"description":"Previously uploaded identical media","content":{"application/json":{"schema":ref("ID")}}}
upload["parameters"] += [{"name":"X-File-Name","in":"header","schema":S},{"name":"X-Audio-Duration","in":"header","schema":{"type":"number"}}]
upload["requestBody"]={"required":True,"content":{mime:{"schema":{"type":"string","format":"binary"}} for mime in ["image/jpeg","image/png","image/webp","audio/webm","audio/mp4","audio/ogg","audio/wav","audio/mpeg"]}}
download=operation(root+"/media/{media}","get","Read authenticated media; supports range requests")
download["responses"]["200"]={"description":"Private file bytes","content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}}
download["responses"]["206"]={"description":"Partial content"}
download["parameters"].append({"name":"Range","in":"header","schema":S})
observationBody={"title":{"type":"string","maxLength":160},"description":{"type":"string","maxLength":10000},"label":{"type":"string","maxLength":100},"status":enum("draft","approved","rejected")}
operation(inspection+"/batches/{batch}/observations","post","Add manual observation",ref("ID"),obj({"id":UUID,**observationBody},["id"]),201)
operation(inspection+"/observations/{observation}","put","Edit/review an observation with expected version",ref("Version"),obj({**observationBody,"version":INT},["status","version"]))
operation(inspection+"/report","post","Finalise immutable report and lock inspection",ref("Report"),obj({"signatures":{"type":"array","maxItems":10,"items":ref("SignatureInput")}},[]),201,description="Optional signatures include signer name, role and normalized handwritten strokes; timestamps and collector identity are assigned by the server and frozen in the report. All batches must be reviewed or excluded; all expected included media must be uploaded; analysis must be finished or explicitly skipped. Only approved text and associated photos enter the snapshot. Audio remains internal.")
operation(inspection+"/report","get","Read immutable report snapshot",ref("Report"))

privilege = enum("inspections.read","inspections.write","norms.read","norms.manage","benchmarks.read","settings.manage")
outcome = enum("acceptable","unacceptable","not_assessable","not_applicable")
schemas["Role"] = obj({"id":UUID,"name":S,"description":S,"privileges":array(privilege),"systemKey":{"type":["string","null"]},"version":INT,"memberCount":INT,"invitationCount":INT})
schemas["Privilege"] = obj({"key":privilege,"label":S,"description":S,"group":S})
schemas["RoomElement"] = obj({"id":UUID,"name":S,"description":S,"rooms":array(S),"aliases":array(S),"archived":{"type":"boolean"},"version":INT})
schemas["NormExample"] = obj({"id":UUID,"outcome":outcome,"caption":S,"transcript":S,"assetId":UUID},["id","outcome","caption"])
schemas["NormRule"] = obj({"id":UUID,"code":S,"title":S,"rooms":array(S),"objectType":S,"elementId":UUID,"acceptable":S,"unacceptable":S,"aiGuidance":{"type":"string","maxLength":6500},"modalities":array(enum("photo","audio")),"priority":enum("low","medium","high"),"sourceUrls":array(S),"examples":array(ref("NormExample"))},["id","code","title","rooms","objectType","acceptable","unacceptable","aiGuidance","modalities","priority","sourceUrls","examples"])
schemas["NormSource"] = obj({"title":S,"url":S,"checkedAt":S})
summary={"id":UUID,"frameworkId":UUID,"number":INT,"name":S,"description":S,"status":enum("draft","published"),"revision":INT}
schemas["NormSummary"] = obj({**summary,"ruleCount":INT,"publishedAt":{"type":["string","null"]}})
schemas["NormDocument"] = obj({**summary,"rules":array(ref("NormRule")),"sources":array(ref("NormSource"))})
schemas["NormAssessment"] = obj({"id":UUID,"batchId":UUID,"ruleId":UUID,"normVersionId":UUID,"outcome":outcome,"reason":S,"photoIds":array(UUID),"audioIds":array(UUID),"source":enum("ai","mock","system"),"reviewedOutcome":{"type":["string","null"]},"reviewNote":S,"stale":{"type":"boolean"},"version":INT})
schemas["Inspection"]["properties"]["normVersionId"]={"type":["string","null"],"format":"uuid"}
schemas["Media"]["properties"].update({"transcript":S,"transcriptVersion":INT})
point = obj({"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1}})
schemas["PhotoAnnotation"] = obj({"tool":enum("pen","arrow","ellipse"),"color":enum("#dc2626","#eab308","#2563eb"),"points":{"type":"array","items":point,"minItems":2,"maxItems":12000}})
shapes = {"type":"array","items":ref("PhotoAnnotation"),"maxItems":200}
schemas["Media"]["properties"].update({"annotations":shapes,"annotationVersion":INT})
operation(inspection+"/media/{media}/annotations","get","Read photo annotations and revision",obj({"shapes":shapes,"version":INT}),description="Requires inspections.read. Coordinates refer to the EXIF-oriented original photo. Original media is unchanged.")
operation(inspection+"/media/{media}/annotations","put","Save photo annotations with expected revision",ref("Version"),obj({"shapes":shapes,"version":INT}),description="Requires inspections.write on a draft inspection. Maximum 12000 points across 200 shapes; arrows/ellipses have exactly two points. Conflicts return 409. Annotations are frozen in reports and rendered by the PDF container; they do not retrigger AI analysis.")
schemas["Observation"]["properties"]["audioIds"]=array(UUID)
schemas["Dossier"]["properties"].update({"norms":{"anyOf":[ref("NormDocument"),{"type":"null"}]},"assessments":array(ref("NormAssessment"))})
schemas["Report"]["properties"].update({"norms":{"anyOf":[ref("NormDocument"),{"type":"null"}]},"assessments":array(obj({"ruleId":UUID,"batchId":UUID,"outcome":outcome,"reason":S,"photoIds":array(UUID)}))})
roleBody=obj({"name":S,"description":S,"privileges":array(privilege),"version":INT},["name","privileges"])
operation(root+"/roles","get","List organisation roles and privilege catalog (settings.manage)",obj({"roles":array(ref("Role")),"privileges":array(ref("Privilege"))}))
operation(root+"/roles","post","Create a custom organisation role",ref("ID"),roleBody,201)
operation(root+"/roles/{role}","put","Edit role privileges with expected version; retain an organisation manager",ref("Version"),roleBody)
operation(root+"/roles/{role}","delete","Delete role without memberships or invitations",ref("OK"))
elementBody=obj({k:v for k,v in schemas["RoomElement"]["properties"].items() if k!="id"},["name","rooms"])
operation(root+"/elements","get","List room element definitions (norms.read)",array(ref("RoomElement")))
operation(root+"/elements","post","Create room element definition (norms.manage)",ref("RoomElement"),elementBody,201)
operation(root+"/elements/{element}","put","Edit or archive room element with expected version (norms.manage)",ref("Version"),elementBody,description="New inspections snapshot active definitions. Existing inspection context never changes when a catalog element is edited.")
operation(root+"/norms","get","List published norms; authors also see drafts (norms.read)",array(ref("NormSummary")))
operation(root+"/norms","post","Create draft, optionally with researched baseline (norms.manage)",ref("NormDocument"),obj({"name":S,"baseline":{"type":"boolean"}},["name"]),201)
operation(root+"/norms/{norm}","get","Read norm version; drafts require norms.manage",ref("NormDocument"))
operation(root+"/norms/{norm}","put","Save draft with expected revision (norms.manage)",obj({"revision":INT}),obj({"name":S,"description":S,"rules":array(ref("NormRule")),"revision":INT},["name","rules","revision"]))
operation(root+"/norms/{norm}/publish","post","Publish immutable version after validating criteria and both example outcomes",ref("OK"),obj({"revision":INT}))
operation(root+"/norms/{norm}/revisions","post","Copy published norm into next draft; return existing draft if present",ref("ID"),obj({}),201)
benchmark=operation(root+"/norms/benchmark","get","Aggregate confirmed assessments by rule and room (benchmarks.read)",obj({"norms":ref("NormDocument"),"rows":array(obj({"ruleId":UUID,"room":S,**{key:INT for key in ["acceptable","unacceptable","notAssessable","notApplicable","pending"]}}))}),description="Counts assessments, not dwellings. Excluded captures are omitted. Stale/unconfirmed outcomes are pending. Unassessable and inapplicable outcomes never count as passes.")
benchmark["parameters"].append({"name":"normVersionId","in":"query","required":True,"schema":UUID})
assetUpload=operation(root+"/norm-assets/{asset}","put","Upload immutable private reference example (norms.manage)",ref("ID"),status=201)
assetUpload["requestBody"]=upload["requestBody"]
assetUpload["parameters"].append({"name":"X-File-Name","in":"header","schema":S})
assetDownload=operation(root+"/norm-assets/{asset}","get","Read private reference example (norms.read)")
assetDownload["responses"]["200"]=download["responses"]["200"]
assetDownload["responses"]["206"]={"description":"Partial content"}
assetDownload["parameters"].append({"name":"Range","in":"header","schema":S})
operation(inspection+"/media/{media}/transcript","put","Save editable audio transcript and restart analysis",ref("Version"),obj({"transcript":{"type":"string","maxLength":20000},"version":INT}),description="Requires inspections.write. No automatic transcription. Invalidates assessment reviews and processing leases; blocks finalisation until reanalysis or explicit manual review.")
operation(inspection+"/assessments/{assessment}","put","Confirm or override norm assessment with expected version",ref("Version"),obj({"outcome":outcome,"note":{"type":"string","maxLength":3000},"version":INT}),description="Requires inspections.write and completed/skipped analysis. Manual or changed outcomes require a note. Finalised inspections reject changes.")

schemas["Report"]["properties"].update({"organisation":obj({"name":S}),"createdBy":obj({"name":S}),"finalisedBy":obj({"name":S})})
pdf = operation(inspection+"/report/pdf","post","Render and download an A4 report using the private Docker PDF service",body=obj({}),description="Requires inspections.read. Final exports use the immutable saved snapshot. Draft exports contain only reviewed captures, approved observations and confirmed norms, and are visibly marked Concept. Photos and fonts are embedded; original audio and raw transcripts are excluded. Returns 503 if rendering or any source photo is unavailable; no partial PDF is returned.")
pdf["responses"]["200"]={"description":"PDF download","headers":{"Content-Disposition":{"schema":S},"X-Satvey-Report-Status":{"schema":enum("draft","final")}},"content":{"application/pdf":{"schema":{"type":"string","format":"binary"}}}}

# The property catalog has its own identity and a frozen copy in each inspection.
nullable_uuid={"type":["string","null"],"format":"uuid"}
nullable_text={"type":["string","null"]}
schemas["PropertyArea"]=obj({"value":{"type":"number"},"kind":S,"kindCode":S,"unit":S,"startDate":S,"endDate":S},["value","kind","kindCode","unit"])
schemas["PropertyCluster"]=obj({"id":S,"code":S,"name":S,"kind":S,"kindCode":S})
property_optional={"bagObjectId":S,"bagAddressId":S,"bagBuildingIds":array(S),"complexId":S,"complexName":S,"clusters":array(ref("PropertyCluster")),"objectType":S,"objectTypeCode":S,"buildYear":INT,"area":{"type":"number"},"areaType":S,"areaTypeCode":S,"areaUnit":S,"areas":array(ref("PropertyArea")),"sourceStatus":S,"sourceStatusCode":S,"sourceKeys":{"type":"object","additionalProperties":S}}
property_required={"id":UUID,"address":S,"postcode":S,"city":S,"sourceId":nullable_uuid,"sourceObjectId":nullable_text,"sourceName":nullable_text,"sourceKind":nullable_text,"administration":nullable_text,"objectNumber":S,"linkState":enum("linked","provisional","merged"),"mergedInto":nullable_uuid,"fetchedAt":nullable_text,"revision":INT}
schemas["Property"]=obj({**property_required,**property_optional},list(property_required))
schemas["PropertyPage"]=obj({"items":array(ref("Property")),"total":INT,"page":INT,"pageSize":{"type":"integer","const":25}})
schemas["Inspection"]["properties"].update({"propertySnapshot":ref("Property"),"propertyContextVersion":INT,"propertyChanged":{"type":"boolean"}})
schemas["NormAssessment"]["properties"].update({"previousReviewedOutcome":nullable_text,"previousReviewNote":S})
source_input={"id":UUID,"name":S,"administration":S,"kind":enum("csv","vera"),"baseUrl":S,"tokenUrl":S,"authKind":enum("api_key","oauth2"),"clientId":S,"scopes":S,"enabled":{"type":"boolean"},"revision":INT,"secret":{**S,"writeOnly":True}}
schemas["PropertySourceInput"]=obj(source_input,["id","name","administration","kind","enabled"])
schemas["PropertySource"]=obj({**{k:v for k,v in source_input.items() if k!="secret"},"secretConfigured":{"type":"boolean"},"lastSyncedAt":nullable_text,"lastError":S,"nextSyncAt":S})
schemas["PropertySyncJob"]=obj({"id":UUID,"sourceId":UUID,"sourceName":S,"propertyId":nullable_uuid,"status":enum("pending","processing","done","failed"),"attempts":INT,"processed":INT,"error":S,"createdAt":S,"finishedAt":nullable_text})
schemas["PropertySourceData"]=obj({"sources":array(ref("PropertySource")),"jobs":array(ref("PropertySyncJob"))})
catalog_row=obj({"sourceObjectId":S,"objectNumber":S,"address":S,"postcode":S,"city":S,**property_optional},["sourceObjectId","objectNumber","address","postcode","city"])
schemas["PropertyImport"]=obj({"id":UUID,"errors":array(S),"rows":INT,"created":INT,"updated":INT,"unchanged":INT,"changes":array(obj({"before":{"anyOf":[catalog_row,{"type":"null"}]},"after":catalog_row})),"changesTruncated":{"type":"boolean"}},["errors","rows"])

for route,methods in spec["paths"].items():
 if route.startswith("/orgs/"):
  for op in methods.values():
   op.setdefault("parameters",[]).append({"name":"X-Satvey-User","in":"header","required":False,"schema":UUID,"description":"Browser account binding: reject a scoped request with 401 if the current cookie belongs to another user."})

destination=Path(__file__).resolve().parents[1]/"docs"/"openapi.json"
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(spec,ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n")
print(f"Wrote {len(spec['paths'])} API paths")
