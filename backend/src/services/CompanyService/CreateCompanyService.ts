import * as Yup from "yup";
import AppError from "../../errors/AppError";
import Company from "../../models/Company";
import User from "../../models/User";
import Setting from "../../models/Setting";
import sequelize from "../../database";

interface CompanyData {
  name: string;
  phone?: string;
  email?: string;
  status?: boolean;
  planId?: number;
  campaignsEnabled?: boolean;
  dueDate?: string;
  recurrence?: string;
  document?: string;
  paymentMethod?: string;
}

const CreateCompanyService = async (
  companyData: CompanyData
): Promise<Company> => {
  const {
    name,
    phone,
    email,
    status,
    planId,
    campaignsEnabled,
    dueDate,
    recurrence,
    document,
    paymentMethod
  } = companyData;

  const companySchema = Yup.object().shape({
    name: Yup.string()
      .min(2, "ERR_COMPANY_INVALID_NAME")
      .required("ERR_COMPANY_INVALID_NAME")
  });

  try {
    await companySchema.validate({ name });
  } catch (err: any) {
    throw new AppError(err.message);
  }

  const t = await sequelize.transaction();

  try {
    const company = await Company.create(
      {
        name,
        phone,
        email,
        status,
        planId,
        dueDate,
        recurrence,
        document,
        paymentMethod
      },
      { transaction: t }
    );

    await User.create(
      {
        name: company.name,
        email: company.email,
        password: "mudar123",
        profile: "admin",
        companyId: company.id
      },
      { transaction: t }
    );

    if (companyData.campaignsEnabled !== undefined) {
      const [setting, created] = await Setting.findOrCreate({
        where: {
          companyId: company.id,
          key: "campaignsEnabled"
        },
        defaults: {
          companyId: company.id,
          key: "campaignsEnabled",
          value: `${campaignsEnabled}`
        },
        transaction: t
      });
      if (!created) {
        await setting.update(
          { value: `${campaignsEnabled}` },
          { transaction: t }
        );
      }
    }
    await t.commit();

    return company;
  } catch (error) {
    await t.rollback();
    throw new AppError("Não foi possível criar a empresa");
  }
};

export default CreateCompanyService;