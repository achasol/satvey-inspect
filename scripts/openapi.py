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
 for name in ["org", "inspection", "batch", "media", "observation", "user", "token", "norm", "asset", "assessment", "role", "element", "property", "source", "import", "handover", "destination", "delivery", "agreement", "room", "format", "answer", "job"]:
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
operation(inspection+"/rooms","post","Add a named room of a pinned template type idempotently",ref("Room"),obj({"id":UUID,"name":S,"categoryId":UUID},["id","name"]),201,description="For template inspections, categoryId must identify a non-property scope of the pinned template. Every physical room type may have multiple named instances; each receives its own answers. Whole-property scope cannot be duplicated.")
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

# Handover proposals evolve independently of the immutable inspection report.
schemas["VERAHandoverContext"]=obj({k:S for k in ["unitUri","organisation","administration","inspectionOrderId","reportTypeCode","reportStatusCode","taskStatusCode","requestStatusCode","maintenanceTypeCode"]})
proposal_fields={"id":UUID,"sourceKeys":{"type":"array","items":S,"minItems":1,"maxItems":100,"uniqueItems":True},"description":{**S,"minLength":1,"maxLength":6000},"location":{**S,"maxLength":240},"urgency":enum("unspecified","routine","soon","urgent"),"elementCode":{**S,"maxLength":160},"quantity":{"type":"number","exclusiveMinimum":0,"maximum":1e9},"unit":{**S,"maxLength":40}}
schemas["WorkProposal"]=obj(proposal_fields,[k for k in proposal_fields if k!="quantity"])
schemas["HandoverDraft"]=obj({"version":{"type":"integer","minimum":0},"destination":{**S,"maxLength":160},"externalReference":{**S,"maxLength":512},"proposals":{"type":"array","maxItems":200,"items":ref("WorkProposal")},"vera":ref("VERAHandoverContext")},["version","destination","externalReference","proposals"])
schemas["HandoverDraft"]["properties"]["destinationId"]={"type":"string","description":"Selected automated delivery destination; empty for legacy file-only drafts."}
schemas["HandoverSource"]=obj({"key":S,"kind":enum("observation","answer","assessment"),"title":S,"description":S,"location":S,"photoIds":array(UUID),"value":{"type":["string","number","boolean","null"]},"outcome":S},["key","kind","title","description","location","photoIds"])
schemas["HandoverPhoto"]=obj({"id":UUID,"batchId":UUID,"kind":enum("photo"),"name":S,"annotations":array(ref("PhotoAnnotation"))},["id","batchId","kind","name"])
schemas["HandoverReport"]=obj({"id":UUID,"inspectionId":UUID,"kind":enum("pre","final"),"createdAt":{"type":"string","format":"date-time"},"organisation":S,"author":S,"property":ref("Property"),"sources":array(ref("HandoverSource")),"photos":array(ref("HandoverPhoto"))})
schemas["HandoverAttachment"]=obj({"path":S,"mime":S,"mediaId":UUID,"sha256":S,"bytes":INT,"original":{"type":"boolean"}},["path","mime"])
schemas["HandoverBundle"]=obj({"schemaVersion":{"type":"string","const":"satvey.handover/1"},"id":UUID,"createdAt":{"type":"string","format":"date-time"},"draftVersion":INT,"destination":S,"externalReference":S,"report":ref("HandoverReport"),"proposals":array(ref("WorkProposal")),"attachments":array(ref("HandoverAttachment")),"vera":ref("VERAHandoverContext")},["schemaVersion","id","createdAt","draftVersion","destination","externalReference","report","proposals","attachments"])
schemas["HandoverExport"]=obj({"id":UUID,"draftVersion":INT,"destination":S,"createdAt":S,"lastDownloadAt":{"type":["string","null"]},"proposalCount":INT})
schemas["HandoverData"]=obj({"draft":ref("HandoverDraft"),"report":ref("HandoverReport"),"exports":array(ref("HandoverExport"))})
schemas["HandoverReceipt"]=obj({"key":S,"receiverId":S,"uri":{"type":"string","format":"uri"},"acceptedAt":S})
schemas["HandoverDelivery"]=obj({"id":UUID,"inspectionId":UUID,"destinationId":UUID,"destination":S,"draftVersion":INT,"status":enum("queued","processing","retrying","blocked","accepted"),"attempts":INT,"error":S,"createdAt":S,"acceptedAt":{"type":["string","null"]},"nextAttemptAt":S,"acceptedCount":INT,"receipts":array(ref("HandoverReceipt")),"proposals":array(ref("WorkProposal"))})
schemas["HandoverDestinationChoice"]=obj({"id":UUID,"name":S,"enabled":{"type":"boolean"},"ready":{"type":"boolean"},"reason":S})
schemas["HandoverData"]["properties"].update({"destinations":array(ref("HandoverDestinationChoice")),"deliveries":array(ref("HandoverDelivery"))})
schemas["HandoverData"]["required"] += ["destinations","deliveries"]
destination_fields={k:S for k in ["name","onderhoudUrl","dossierUrl","vastgoedUrl","tokenUrl","clientId","scopes","organisation","administration","reportTypeCode","maintenanceTypeCode"]}
schemas["HandoverDestination"]=obj({"id":UUID,"revision":INT,"enabled":{"type":"boolean"},"secretConfigured":{"type":"boolean"},**destination_fields})
schemas["SaveHandoverDestination"]=obj({**schemas["HandoverDestination"]["properties"],"secret":{**S,"writeOnly":True}},["id","revision","enabled","name","onderhoudUrl","dossierUrl","vastgoedUrl","tokenUrl","clientId","organisation","administration"])
schemas["HandoverSettings"]=obj({"destinations":array(ref("HandoverDestination")),"mappings":array(obj({"destinationId":UUID,"propertyId":UUID,"unitUri":S,"address":S})),"deliveries":array(ref("HandoverDelivery"))})
operation(root+"/handover-destinations","get","Read VERA delivery destinations, property mappings and delivery status (settings.manage)",ref("HandoverSettings"))
operation(root+"/handover-destinations","put","Create or update VERA destination with encrypted OAuth2 credentials (settings.manage)",ref("HandoverDestination"),ref("SaveHandoverDestination"),description="Optimistic revision. Empty secret retains existing credentials. Used endpoint identities and content mappings are immutable. Credential/settings changes pause existing jobs until an explicit retry.")
operation(root+"/handover-destinations/{destination}/test","post","Test TLS, OAuth2 and property reads without writes (settings.manage)",obj({"message":S}),obj({}),description="Does not certify write permissions; validate those with an explicitly approved sandbox handover.")
operation(root+"/handover-destinations/{destination}/properties","put","Verify and map a property to a receiving VERA unit (settings.manage)",ref("OK"),obj({"propertyId":UUID,"unitUri":{"type":"string","format":"uri"}}),description="No address matching. A mapping used by an approved delivery is immutable.")
operation(inspection+"/handover/approve","post","Approve an immutable handover revision and queue automatic VERA delivery",ref("ID"),obj({"id":UUID,"version":INT,"destinationId":UUID}),202,description="Requires inspections.write, final linked report and saved current revision. Idempotent by approval ID and destination/revision. Does not create maintenance orders. Only complete receiver acceptance is marked accepted; delivery continues without an open browser.")
operation(inspection+"/handovers/{delivery}/retry","post","Resume a blocked or scheduled delivery after correcting configuration",ref("ID"),obj({}),202,description="Requires inspections.write. Preserves accepted resource checkpoints; accepted deliveries are not sent again. Rebinds rotated credentials to the current destination revision.")
operation(inspection+"/handover","get","Read handover draft, approved sources and export history",ref("HandoverData"),description="Requires inspections.read and a final report with a linked property. Projects a whitelist of report data; internal audio, transcripts and draft answers are excluded.")
operation(inspection+"/handover","put","Save proposed maintenance with optimistic revision",ref("HandoverDraft"),ref("HandoverDraft"),description="Requires inspections.write. Version zero creates the first draft. Proposals must reference sources in the frozen report. Quantity requires a unit. Does not modify the signed report. Conflicts return 409.")
prepared=operation(inspection+"/handovers","post","Freeze a handover revision idempotently",ref("ID"),obj({"id":UUID,"version":{"type":"integer","minimum":1}}),201,description="Requires inspections.write, a saved draft and a destination. Repeated preparation of the same report/revision returns the original ID (200). No external delivery, work commissioning or receipt is implied.")
prepared["responses"]["200"]={"description":"Existing frozen handover","content":{"application/json":{"schema":ref("ID")}}}
download=operation(inspection+"/handovers/{handover}/export","get","Download frozen handover as ZIP, JSON or CSV",description="Requires inspections.read. ZIP includes PDF, approved photos, annotated SVGs, JSON manifest with SHA-256, CSV and optional VERA 4.3.3 import records. Missing evidence or PDF failure aborts ZIP before download headers. Maximum 160 MiB uncompressed. JSON/CSV download independently. lastDownloadAt records offering a download, not receiving-system acceptance.")
download["parameters"].append({"name":"format","in":"query","schema":{**enum("zip","json","csv"),"default":"zip"}})
download["responses"]["200"]={"description":"Handover file","headers":{"Content-Disposition":{"schema":S}},"content":{"application/zip":{"schema":{"type":"string","format":"binary"}},"application/json":{"schema":ref("HandoverBundle")},"text/csv":{"schema":S}}}


# Customer-readiness workflows. Legacy report formats retain their signing policy.
BOOL={"type":"boolean"}
schemas["Inspection"]["properties"].update({"revision":INT,"archivedAt":nullable_text,"archiveReason":S,"correctsInspectionId":nullable_uuid,"correctionReason":S,"supersededBy":nullable_uuid,"assignedTo":nullable_uuid,"reviewerId":nullable_uuid,"reviewStatus":enum("none","requested","changes_requested","approved"),"reviewNote":S,"priority":enum("normal","high","urgent"),"visitOutcome":enum("scheduled","visited","no_access","cancelled"),"visitedAt":nullable_text,"externalReference":S,"mutationCaseId":nullable_uuid,"predecessorId":nullable_uuid,"retentionHold":BOOL,"retentionHoldReason":S})
schemas["Media"]["properties"]["contentDeletedAt"]=nullable_text
schemas["Agreement"]=obj({"id":UUID,"description":S,"responsibility":enum("resident","corporation"),"dueDate":nullable_text,"status":enum("open","completed","disputed","withdrawn"),"note":S,"photoIds":array(UUID),"version":INT,"sourceAgreementId":nullable_uuid},["id","description","responsibility","status","note","photoIds","version"])
for name in ["Dossier","Report"]: schemas[name]["properties"]["agreements"]=array(ref("Agreement"))
schemas["SigningException"]=obj({"outcome":enum("absent","refused","unable"),"note":{**S,"minLength":1,"maxLength":2000}})
schemas["Report"]["properties"].update({"signingException":{"anyOf":[ref("SigningException"),{"type":"null"}]},"disagreement":S,"acknowledgement":S,"organisation":obj({"id":UUID,"name":S,"logoAssetId":nullable_uuid},["id","name"])})
for name in ["FormatDocument","Format"]:
 if name in schemas: schemas[name]["properties"].update({"signingPolicy":enum("legacy","resident_or_exception"),"acknowledgement":S})
final=spec["paths"][inspection+"/report"]["post"]
final["requestBody"]["content"]["application/json"]["schema"]=obj({"version":INT,"signatures":array(ref("SignatureInput")),"signingException":{"anyOf":[ref("SigningException"),{"type":"null"}]},"disagreement":S},[])
final["description"]="New templates require the current dossier revision, an actual visit time, inspector signature and resident signature or explicit exception. Requested/changes-requested quality reviews block finalization. Legacy templates retain their original signing policy for ordinary visits; corrections always require the new signing safeguards. The report snapshot and first durable PDF artifact are immutable."
action=obj({"reason":{**S,"minLength":1,"maxLength":2000},"version":INT})
operation(inspection,"delete","Archive inspection reversibly",ref("Version"),action,description="Compatibility alias for POST /archive; does not purge evidence.")
for endpoint,description in [("archive","Archive draft with inspections.write; final reports require inspections.archive"),("restore","Restore archived dossier with inspections.archive")]:
 operation(inspection+"/"+endpoint,"post",description,ref("Version"),action)
operation(inspection+"/purge","delete","Permanently purge archived dossier (inspections.purge)",body=action,status=204,description="Requires current revision and reason. Holds, correction lineage and active deliveries block purge. Retains only a minimal audit receipt; object deletion retries independently.")
operation(inspection+"/history","get","Read latest 250 dossier events",array(obj({"id":INT,"action":S,"actor":S,"createdAt":S,"detail":{"type":"object"}})))
operation(inspection+"/corrections","post","Create independent correction dossier idempotently",ref("ID"),action,201,description="Copies evidence to separate object ownership, preserves original report and resets review/signatures. An existing correction returns 200.")
page=operation(root+"/inspection-page","get","Read inspection queue and matching server totals",obj({"items":array(ref("Inspection")),"total":INT,"open":INT}))
page["parameters"] += [{"name":"q","in":"query","schema":S},{"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100}},{"name":"offset","in":"query","schema":INT},{"name":"view","in":"query","schema":enum("all","mine","today","overdue","unassigned","review","delivery","archived")}]
operation(root+"/planning-members","get","Read possible owners and quality reviewers",array(obj({"id":UUID,"name":S,"reviewer":BOOL,"writer":BOOL})))
operation(inspection+"/planning","put","Assign and reschedule draft visit (inspections.plan)",ref("Version"),obj({"version":INT,"assignedTo":nullable_uuid,"scheduledAt":nullable_text,"visitedAt":nullable_text,"priority":enum("normal","high","urgent"),"visitOutcome":enum("scheduled","visited","no_access","cancelled"),"externalReference":S}))
operation(inspection+"/visit","put","Record actual visit and access outcome",ref("Version"),obj({"version":INT,"visitedAt":nullable_text,"visitOutcome":enum("scheduled","visited","no_access","cancelled")}))
operation(inspection+"/quality-review","post","Request review or record assigned reviewer decision",ref("Version"),obj({"version":INT,"action":enum("requested","approved","changes_requested"),"reviewerId":UUID,"note":S}),description="Approval requires inspections.review and an independent assigned reviewer. Content revisions invalidate approval.")
for suffix in ["/agreements","/agreements/{agreement}"]:
 operation(inspection+suffix,"put","Create or edit versioned resident/corporation agreement",ref("Version"),ref("Agreement"),description="Version 0 creates; current version updates. Completed requires evidence or control note. Disputed/withdrawn requires explanation. Source photographs must belong to this dossier.")
operation(inspection+"/followups","post","Create fresh linked follow-up visit",ref("ID"),obj({"id":UUID,"version":INT,"formatVersionId":UUID,"reference":S,"scheduledAt":nullable_text}),201,description="Idempotent client ID. Carries room structure and open/disputed agreements, with no old condition answers or evidence. Links the explicit mutation case.")
operation(root+"/properties/{property}/history","get","Read latest 250 property inspections",array(ref("Inspection")))
operation(inspection+"/rooms/{room}","put","Rename room and invalidate approval",obj({"generation":INT}),obj({"name":S,"generation":INT}))
operation(inspection+"/batches/{batch}/move","post","Move selected evidence to another room",ref("OK"),obj({"roomId":UUID,"mediaIds":array(UUID),"version":INT}),description="Requires all source files uploaded and no active processing. Invalidates affected reviews and preserves an audit record.")
operation(inspection+"/report/deliveries","get","Read latest 100 report email attempts",array(obj({"id":UUID,"reportId":UUID,"recipient":S,"createdAt":S,"status":enum("pending","processing","accepted","failed","cancelled","uncertain"),"error":S})))
operation(inspection+"/report/email","post","Queue exact frozen PDF as email attachment",ref("ID"),obj({"id":UUID,"recipient":S,"reportId":UUID}),202,description="Idempotent request ID. SMTP acceptance is not proof of inbox delivery. Uncertain post-DATA outcomes require explicit operator resend. Configured size limit defaults to 10 MiB.")
manual=obj({"id":UUID,"reportId":UUID,"recipient":S,"channel":S,"reference":S,"note":S,"acknowledged":BOOL,"reconciliation":S})
operation(inspection+"/manual-handovers","get","Read recorded manual customer handovers",array(obj({**{k:v for k,v in manual["properties"].items() if k!="reconciliation"},"createdAt":S})))
operation(inspection+"/manual-handovers","post","Record handover performed via agreed customer channel",ref("ID"),manual,201,description="Does not send files. Resolving an active VERA job requires administrator reconciliation; manual resolution stops automatic resends.")
measurement=obj({**{name:{"type":"number","minimum":0,"maximum":1440} for name in ["captureMinutes","reviewMinutes","reportMinutes","reentryMinutes","supportMinutes"]},"note":S,"version":INT})
operation(inspection+"/measurement","get","Read manually measured active visit minutes",array(measurement))
operation(inspection+"/measurement","put","Save measured minutes with optimistic version",ref("Version"),measurement)
operation(root+"/pilot-metrics","get","Read pilot rows without property addresses (inspections.plan)",obj({"rows":array({"type":"object"}),"measurement":S,"generatedAt":S}))
policy=obj({"reportDays":{"type":["integer","null"],"minimum":1,"maximum":36500},"audioDays":{"type":["integer","null"],"minimum":1,"maximum":36500},"transcriptDays":{"type":["integer","null"],"minimum":1,"maximum":36500},"enabled":BOOL,"version":INT})
operation(root+"/retention","get","Read retention policy and dry-run counts (settings.manage)",obj({"policy":policy,"preview":{"type":"object","additionalProperties":INT},"note":S}))
operation(root+"/retention","put","Save or explicitly activate retention policy (settings.manage)",ref("Version"),policy,description="Disabled by default; null periods preserve that data category. Report term begins at archive. Holds/lineage/deliveries are rechecked by worker. Backups have separate retention.")
operation(inspection+"/retention-hold","put","Apply or release reasoned deletion hold (settings.manage)",ref("Version"),obj({"hold":BOOL,"reason":S,"version":INT}))
operation(root+"/offline-grant","get","Authorize configured offline access window",obj({"userId":UUID,"orgId":UUID,"authorizedAt":S,"expiresAt":S}))
operation(root+"/offline-settings","get","Read organisation offline window (settings.manage)",obj({"hours":INT,"version":INT}))
operation(root+"/offline-settings","put","Set offline window from 1 to 168 hours (settings.manage)",ref("Version"),obj({"hours":{"type":"integer","minimum":1,"maximum":168},"version":INT}))
identity=obj({"name":S,"logoAssetId":nullable_uuid,"version":INT})
operation(root+"/report-identity","get","Read report branding (settings.manage)",identity)
operation(root+"/report-identity","put","Set report name and tenant-owned image logo (settings.manage)",ref("Version"),identity,description="Logo at most 1 MiB; frozen in subsequent reports. Current settings version required.")
operation("/public-information","get","Read configured public operator/support/privacy information",obj({"app":S,"entity":S,"supportEmail":S,"privacyURL":S,"hostingRegion":S}),public=True)
operation("/account/delete","post","Delete own login and memberships after recent authentication",obj({"status":S,"note":S}),obj({"confirmation":S}),description="Requires exact email confirmation, authentication within 10 minutes and transfer of last-admin ownership. Pseudonymizes retained corporate audit identity; corporate dossiers follow organisation policy.")
exit=operation(root+"/exit-export","get","Export tenant data and source files in ZIP parts (settings.manage)",description="Pause organisation writes for consistent exit. Use the same before cutoff and manifest lastInspectionId as after until hasMore=false. Maximum 25 inspections/2 GiB per part. Includes frozen PDFs, report snapshots, catalog/configuration, evidence, agreement and delivery history; credentials excluded.")
exit["parameters"] += [{"name":n,"in":"query","schema":S} for n in ["before","after"]]+[{"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":25,"default":10}}]
exit["responses"]["200"]={"description":"Tenant ZIP part","content":{"application/zip":{"schema":{"type":"string","format":"binary"}}}}
operation("/auth/mobile/start","post","Start PKCE native login using system browser",obj({"url":S}),obj({"challenge":S,"state":S}),public=True)
operation("/auth/mobile/authorize","post","Authorize one native login from authenticated browser",obj({"url":S}),obj({"request":S}))
operation("/auth/mobile/exchange","post","Consume one PKCE code for native bearer session",obj({"token":S,"expiresAt":S,"userId":UUID}),obj({"code":S,"verifier":S}),public=True)
spec["components"]["securitySchemes"]["nativeBearer"]={"type":"http","scheme":"bearer","description":"Opaque native session from PKCE exchange; never accepted as a web cookie."}
spec["security"].append({"nativeBearer":[]})

# Template and room-review contract used by prepared visits and signing policy.
question=obj({"id":UUID,"title":S,"kind":enum("text","boolean","number","choice","quality","evidence"),"required":BOOL,"evidence":enum("none","photo","statement","photo_statement"),"minPhotos":INT,"instruction":S,"talkingPrompt":S,"unit":S,"choices":array(S),"ruleId":S,"condition":{"type":["object","null"],"additionalProperties":True}},["id","title","kind","required","evidence"])
scope=obj({"id":UUID,"name":S,"normRoom":S,"property":BOOL,"required":BOOL,"repeatable":BOOL,"questions":array(question)})
schemas["FormatDocument"]=obj({"id":UUID,"formatId":UUID,"number":INT,"name":S,"description":S,"kind":enum("pre","final"),"normVersionId":nullable_uuid,"status":enum("draft","published"),"revision":INT,"scopes":array(scope),"signingPolicy":enum("legacy","resident_or_exception"),"acknowledgement":S})
schemas["FormatAnswer"]=obj({"id":UUID,"roomId":UUID,"questionId":UUID,"value":{"type":["string","number","boolean","null"]},"outcome":S,"reason":S,"status":enum("missing","suggested","confirmed","unanswerable"),"photoIds":array(UUID),"audioIds":array(UUID),"transcriptVersions":{"type":"object","additionalProperties":INT},"human":BOOL,"version":INT})
for name in ["Dossier","Report"]:schemas[name]["properties"].update({"format":{"anyOf":[ref("FormatDocument"),{"type":"null"}]},"answers":array(ref("FormatAnswer"))})
operation(root+"/formats","get","Read available published and manageable draft templates",array(ref("FormatDocument")))
operation(root+"/formats","post","Create draft inspection template",ref("ID"),obj({"name":S,"kind":enum("pre","final"),"normVersionId":nullable_uuid},["name","kind"]),201)
operation(root+"/formats/{format}","get","Read inspection template and signing policy",ref("FormatDocument"))
operation(root+"/formats/{format}","put","Update draft template with optimistic revision",obj({"revision":INT}),ref("FormatDocument"))
operation(root+"/formats/{format}/publish","post","Validate and publish immutable template",ref("ID"),obj({"revision":INT}))
operation(root+"/formats/{format}/revisions","post","Create revised template with modern signing policy",ref("ID"),obj({}),201)
operation(inspection+"/answers/{answer}","put","Save answer with source and transcript versions",ref("Version"),ref("FormatAnswer"))
operation(inspection+"/rooms/{room}/approval","put","Approve current room generation and answer/observation versions",ref("OK"),obj({"generation":INT,"versions":{"type":"object","additionalProperties":INT},"observationVersions":{"type":"object","additionalProperties":INT},"exception":S}),description="A reasoned room exception preserves what was not inspected. Rechecks evidence and current transcript versions.")
operation(inspection+"/rooms/{room}/analysis","post","Queue room analysis for current evidence",ref("OK"),obj({}),202)
operation(inspection+"/media/{media}/transcription","post","Queue transcription retry",ref("OK"),obj({}),202)

# Visual/workflow review: versioned reports, criterion scores, internal sync and automatic analytics.
responsibility=enum("corporation","resident","undetermined")
schemas["ScoreDetail"]=obj({"score":{"type":["integer","null"],"minimum":1,"maximum":6},"repairResponsibility":responsibility,"costResponsibility":responsibility,"note":{**S,"maxLength":2000}})
schemas["ScoreReference"]=obj({"id":UUID,"assetId":UUID,"name":S,"mime":enum("image/jpeg","image/png","image/webp","application/pdf"),"caption":S})
schemas["ScoreLevel"]=obj({"score":{"type":"integer","minimum":1,"maximum":6},"label":S,"description":S,"outcome":enum("acceptable","unacceptable"),"repairResponsibility":responsibility,"costResponsibility":responsibility,"references":{"type":"array","maxItems":6,"items":ref("ScoreReference")}})
schemas["NormRule"]["properties"]["scoreLevels"]={"type":"array","maxItems":6,"items":ref("ScoreLevel"),"description":"Empty for legacy binary rules; otherwise exactly six unique scores with a criterion-specific outcome mapping. This is a configurable scale, not a NEN certification."}
for name in ["NormAssessment","FormatAnswer"]:
 schemas[name]["properties"].update({"scoreDetail":{"anyOf":[ref("ScoreDetail"),{"type":"null"}]},"proposedScore":{"type":["integer","null"],"minimum":1,"maximum":6}})
spec["paths"][inspection+"/assessments/{assessment}"]["put"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["scoreDetail"]={"anyOf":[ref("ScoreDetail"),{"type":"null"}]}
schemas["Report"]["properties"].update({"number":INT,"rendererVersion":INT,"organisation":{"type":"object","additionalProperties":True}})
schemas["Inspection"]["properties"]["latestReportId"]=nullable_uuid
schemas["Organisation"]["properties"].update({"tint":S,"logoAssetId":nullable_uuid})
identity["properties"]["tint"]={**S,"pattern":"^(#[0-9a-fA-F]{6})?$"}
operation(inspection+"/report/reopen","post","Open current dossier for a new report version",ref("Version"),obj({"version":INT,"reportId":UUID},["version"]),description="Materializes the old frozen PDF before edits. Preserves old report snapshots, artifacts and signatures; subsequent issuance is a new version of the same dossier.")
operation(inspection+"/report/versions","get","List issued versions newest first",array(obj({"id":UUID,"number":INT,"createdAt":S,"createdBy":S})))
for suffix,method in [("/report","get"),("/report/pdf","post")]:
 spec["paths"][inspection+suffix][method]["parameters"].append({"name":"reportId","in":"query","schema":UUID,"description":"Select an immutable issued report version belonging to this dossier."})
spec["paths"][inspection+"/report"]["post"]["summary"]="Issue the next immutable report version"
spec["paths"][inspection+"/report"]["post"]["description"]="New templates and reissued reports require current dossier revision, actual visit time, inspector signature and resident signature or explicit exception. Quality oversight never blocks inspector issuance. Earlier versions and PDFs remain immutable. Legacy renderer remains available for original snapshots."
spec["paths"][inspection+"/quality-review"]["post"].update({"summary":"Record non-blocking reviewer feedback (inspections.review)","description":"Independent reviewer/admin oversight; no inspector request action and no finalization gate. Decisions are audited."})
spec["paths"][inspection+"/quality-review"]["post"]["requestBody"]["content"]["application/json"]["schema"]=obj({"version":INT,"action":enum("approved","changes_requested"),"note":S})
spec["paths"][inspection+"/quality-review"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]=ref("OK")
assetUpload["requestBody"]["content"]["application/pdf"]={"schema":{"type":"string","format":"binary"}}
assetDownload["responses"]["200"].setdefault("content",{})["application/pdf"]={"schema":{"type":"string","format":"binary"}}
for name in ["captureSessionId","audioSegmentId"]:
 schemas["Media"]["properties"][name]=nullable_uuid
schemas["Media"]["properties"]["recordedAt"]=nullable_text
for path,methods in spec["paths"].items():
 if path.endswith("/media/{media}") and "put" in methods:
  methods["put"]["parameters"] += [{"name":name,"in":"header","schema":S} for name in ["X-Capture-Session","X-Audio-Segment","X-Recorded-At"]]
mapping=obj({"enabled":BOOL,"resource":S,"fields":{"type":"object","additionalProperties":S},"testPayload":{"type":"object","additionalProperties":True}})
profile=obj({"destinationId":UUID,"enabled":BOOL,"environment":enum("production","sandbox"),"revision":INT,"openApiUrl":S,"categories":{"type":"object","additionalProperties":mapping},"tests":{"type":"array","items":{"type":"object","additionalProperties":True}},"testedAt":nullable_text},["enabled","environment","revision","openApiUrl","categories"])
schemas["InternalSyncProfile"]=profile
operation(root+"/sync-profiles/{destination}","get","Read category mappings and capability results (settings.manage)",ref("InternalSyncProfile"))
operation(root+"/sync-profiles/{destination}","put","Configure automatic internal ERP synchronization (settings.manage)",ref("InternalSyncProfile"),ref("InternalSyncProfile"),description="Confirmed data only. Categories: property, status, rooms, findings, assessments, agreements, photos, reports, audio, transcripts. Audio and transcripts require explicit enabling. Mappings are supplier-specific. DICO maintenance ordering is deferred.")
operation(root+"/sync-profiles/{destination}/test","post","Read capability probe or explicit sandbox write/read/cleanup test",obj({"revision":INT,"results":array({"type":"object","additionalProperties":True})}),obj({"mode":enum("read","sandbox")}),description="Read mode performs no test writes. Sandbox mode requires a sandbox profile and configured vendor test payload; production write tests are rejected. Results distinguish permissions, unsupported, unknown, read-tested and write-tested capabilities.")
job=array(obj({"id":UUID,"category":S,"sourceRevision":INT,"status":enum("pending","processing","retrying","blocked","done","cancelled"),"error":S,"createdAt":S,"completedAt":nullable_text,"destination":S}))
operation(root+"/sync","get","List recent internal synchronization jobs",job)
operation(inspection+"/sync","get","List dossier synchronization jobs",job)
operation(root+"/sync/{job}/retry","post","Retry a blocked/retrying synchronization job (settings.manage)",ref("OK"),obj({}))
activity=obj({"id":UUID,"inspectionId":UUID,"sessionId":UUID,"roomId":nullable_uuid,"phase":enum("capture","review","report"),"startedAt":{"type":"string","format":"date-time"},"endedAt":{"type":"string","format":"date-time"}})
operation(root+"/activity-events","post","Record idempotent automatic active intervals",obj({"accepted":INT}),obj({"events":{"type":"array","minItems":1,"maxItems":128,"items":activity}}),description="Maximum 30 seconds per interval, last 31 days only. Tenant, room, actor and duplicate payload validated. Does not mutate dossier revisions. Background and idle time must not be submitted.")
a=operation(root+"/analytics","get","Administrator inspector and property insights",{"type":"object","additionalProperties":True},description="settings.manage. Active time is an estimate. Overlapping devices/tabs do not double count a person's time; report versions do not inflate visits. No automatic rankings or manual time inputs.")
a["parameters"] += [{"name":name,"in":"query","schema":S} for name in ["from","to","kind","inspector","property","complex"]]
for route,methods in spec["paths"].items():
 if "/handover" in route and "/handover-destinations" not in route:
  for op in methods.values(): op["deprecated"]=True
 if "/time" in route or "/corrections" in route:
  for op in methods.values(): op["deprecated"]=True

for route,methods in spec["paths"].items():
 if route.startswith("/orgs/"):
  for op in methods.values():
   op.setdefault("parameters",[]).append({"name":"X-Satvey-User","in":"header","required":False,"schema":UUID,"description":"Browser account binding: reject a scoped request with 401 if the current cookie belongs to another user."})

destination=Path(__file__).resolve().parents[1]/"docs"/"openapi.json"
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(spec,ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n")
print(f"Wrote {len(spec['paths'])} API paths")
